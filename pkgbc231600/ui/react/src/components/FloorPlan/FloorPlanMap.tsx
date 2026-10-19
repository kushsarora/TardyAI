/**
 * Interactive floor plan viewer: pan, zoom, a draggable "I'm here" pin, the
 * GPS accuracy circle, and the route polyline for the current floor.
 *
 * All geometry is in the floor's **pixel space** (origin top-left, +Y down), the
 * same space `MapNode#imageX` / `imageY` and `RoutePoint#x` / `y` are authored
 * in. Screen position is produced purely by the CSS transform on the stage
 * element, so no component ever has to maintain a second coordinate system —
 * and converting a pointer event back to pixel space is one `getBoundingClientRect`
 * away regardless of the current zoom.
 */

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Crosshair, Minus, Plus } from 'lucide-react';

import { Floor, MapNode, RouteLeg } from '@/Interfaces';
import { PixelPoint } from '@/lib/geoTransform';
import { resolvePlanUrl } from '@/lib/tardyApi';
import { Button } from '@/components/ui/button';

// Absolute hard floor, only used as a fallback when the viewport hasn't been
// measured yet. In practice the effective minimum zoom is dynamic — the
// "fit the whole floor in the viewport" scale (see getFitZoom) — so the user
// can never zoom out so far that the plan is smaller than the viewport.
const MIN_ZOOM = 0.08;
const MAX_ZOOM = 6;

/** Fraction of the viewport the fitted plan occupies, leaving a small margin. */
const FIT_MARGIN = 0.96;

// Wheel/trackpad zoom tuning. The factor per wheel event is exp(-deltaY * S):
// a smaller sensitivity means gentler zooming, and the MIN/MAX bounds cap how
// far any single event can zoom so a trackpad swipe or big mouse notch can't
// jump across the whole range at once.
const WHEEL_ZOOM_SENSITIVITY = 0.0015;
const MIN_WHEEL_FACTOR = 0.9;
const MAX_WHEEL_FACTOR = 1.1;

/** Pointer travel, in screen px, above which a press is a pan and not a click. */
const CLICK_SLOP_PX = 4;

/**
 * Constrain one axis of the stage translation so the plan can never be dragged
 * out of the viewport.
 *
 * Two regimes, decided by whether the scaled plan is bigger than the viewport:
 *
 * - **Larger (zoomed in).** The offset is held in `[viewportExtent - scaledExtent, 0]`,
 *   i.e. the plan's leading edge can't move past the viewport's leading edge and
 *   its trailing edge can't move short of the trailing one. Every part of the
 *   plan stays reachable, but the viewport is always covered edge to edge, so
 *   there is never dead space beside the map.
 * - **Smaller or equal (fitted).** Centred. This is every axis at fit zoom —
 *   `getFitZoom` deliberately leaves a `FIT_MARGIN` border, so "cover the
 *   viewport" is unsatisfiable there and clamping to a range would just park a
 *   too-small plan against one edge. Centring also makes a pan at fit zoom a
 *   no-op rather than a slide into emptiness.
 */
const clampOffsetAxis = (
  value: number,
  viewportExtent: number,
  scaledExtent: number,
): number => {
  if (scaledExtent <= viewportExtent)
    return (viewportExtent - scaledExtent) / 2;
  return Math.min(Math.max(value, viewportExtent - scaledExtent), 0);
};

interface FloorPlanMapProps {
  floor: Floor;
  /** Every node on this floor — used for connector and destination markers. */
  nodes: MapNode[];
  /** The portion of the active route that happens on this floor, if any. */
  routeLeg?: RouteLeg | null;
  /** Current "I'm here" position in this floor's pixel space, or null if unplaced. */
  pin: PixelPoint | null;
  /** Radius of the GPS accuracy circle in pixels; 0 hides it. */
  accuracyRadiusPx: number;
  /** Destination node id, highlighted when it sits on this floor. */
  destNodeId?: string | null;
  /** When true, a plain click reports its pixel coordinate instead of moving the pin. */
  authorMode: boolean;
  onDestinationSelect?: (node: MapNode) => void;
  onPinChange: (point: PixelPoint) => void;
  onAuthorClick: (point: PixelPoint) => void;
}

type DragMode = 'none' | 'pan' | 'pin';

/**
 * Zoom and pan are one value, not two pieces of state, because the legal range
 * of `offset` depends on `zoom` (see clampOffsetAxis). Updating them separately
 * would let a render observe a new zoom against an offset that is no longer
 * valid for it, and would force the zoom updater to call the offset setter from
 * inside its own updater — which double-applies under StrictMode.
 */
interface ViewTransform {
  zoom: number;
  /** Stage translation in screen px, pre-scale. */
  offset: PixelPoint;
}

export default function FloorPlanMap({
  floor,
  nodes,
  routeLeg,
  pin,
  accuracyRadiusPx,
  destNodeId,
  authorMode,
  onPinChange,
  onDestinationSelect,
  onAuthorClick,
}: FloorPlanMapProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, PixelPoint>());
  const pinchDistance = useRef<number | null>(null);

  const [view, setView] = useState<ViewTransform>({
    zoom: 0.4,
    offset: { x: 0, y: 0 },
  });
  const [imageFailed, setImageFailed] = useState(false);
  const { zoom, offset } = view;

  // Drag bookkeeping lives in a ref: it changes on every pointermove and must
  // not trigger a re-render of its own.
  const dragRef = useRef({
    mode: 'none' as DragMode,
    startClientX: 0,
    startClientY: 0,
    startOffset: { x: 0, y: 0 } as PixelPoint,
    travel: 0,
  });

  const planUrl = resolvePlanUrl(floor.planImageUrl);

  /**
   * The zoom level at which the whole floor just fits inside the viewport.
   * This doubles as the minimum zoom: you cannot zoom out past the point where
   * the entire plan is visible. Falls back to MIN_ZOOM until the viewport and
   * image dimensions are known.
   */
  const getFitZoom = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || !floor.imageWidth || !floor.imageHeight) return MIN_ZOOM;
    const { clientWidth, clientHeight } = viewport;
    if (clientWidth === 0 || clientHeight === 0) return MIN_ZOOM;
    const fit =
      Math.min(
        clientWidth / floor.imageWidth,
        clientHeight / floor.imageHeight,
      ) * FIT_MARGIN;
    return Math.min(Math.max(fit, MIN_ZOOM), MAX_ZOOM);
  }, [floor.imageWidth, floor.imageHeight]);

  /**
   * Clamp a candidate translation against the viewport at a given zoom, so the
   * plan always stays on screen. Returns the offset unchanged only when the
   * viewport has not been measured yet — there is nothing to clamp against, and
   * the fit-to-view layout effect will overwrite it as soon as it has a size.
   */
  const clampOffset = useCallback(
    (candidate: PixelPoint, atZoom: number): PixelPoint => {
      const viewport = viewportRef.current;
      if (!viewport) return candidate;
      const { clientWidth, clientHeight } = viewport;
      if (clientWidth === 0 || clientHeight === 0) return candidate;
      return {
        x: clampOffsetAxis(candidate.x, clientWidth, floor.imageWidth * atZoom),
        y: clampOffsetAxis(
          candidate.y,
          clientHeight,
          floor.imageHeight * atZoom,
        ),
      };
    },
    [floor.imageWidth, floor.imageHeight],
  );

  /** Scale and centre the plan so the whole floor is visible. */
  const fitToView = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || !floor.imageWidth || !floor.imageHeight) return;
    const { clientWidth, clientHeight } = viewport;
    if (clientWidth === 0 || clientHeight === 0) return;

    const clamped = getFitZoom();
    setView({
      zoom: clamped,
      offset: {
        x: (clientWidth - floor.imageWidth * clamped) / 2,
        y: (clientHeight - floor.imageHeight * clamped) / 2,
      },
    });
  }, [floor.imageWidth, floor.imageHeight, getFitZoom]);

  useLayoutEffect(() => {
    fitToView();
  }, [fitToView]);

  useEffect(() => {
    setImageFailed(false);
  }, [planUrl]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => fitToView());
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [fitToView]);

  /** Convert a screen point into this floor's pixel space, clamped to the plan. */
  const toImageCoords = useCallback(
    (clientX: number, clientY: number): PixelPoint | null => {
      const stage = stageRef.current;
      if (!stage) return null;
      const rect = stage.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      const x = ((clientX - rect.left) / rect.width) * floor.imageWidth;
      const y = ((clientY - rect.top) / rect.height) * floor.imageHeight;
      return {
        x: Math.min(Math.max(x, 0), floor.imageWidth),
        y: Math.min(Math.max(y, 0), floor.imageHeight),
      };
    },
    [floor.imageWidth, floor.imageHeight],
  );

  /** Zoom about a fixed screen point so the plan does not slide out from under the cursor. */
  const zoomAbout = useCallback(
    (factor: number, clientX?: number, clientY?: number) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      const anchorX = (clientX ?? rect.left + rect.width / 2) - rect.left;
      const anchorY = (clientY ?? rect.top + rect.height / 2) - rect.top;

      // Floor the zoom at the fit-to-view scale so the plan can never shrink
      // smaller than the viewport, and cap it at MAX_ZOOM.
      const minZoom = getFitZoom();
      setView((previous) => {
        const nextZoom = Math.min(
          Math.max(previous.zoom * factor, minZoom),
          MAX_ZOOM,
        );
        const ratio = nextZoom / previous.zoom;
        // Hold the anchor point still, then clamp: zooming out around a corner
        // shrinks the plan away from the opposite edge, which would otherwise
        // leave the map parked in the margin it just vacated.
        const anchored = {
          x: anchorX - (anchorX - previous.offset.x) * ratio,
          y: anchorY - (anchorY - previous.offset.y) * ratio,
        };
        return { zoom: nextZoom, offset: clampOffset(anchored, nextZoom) };
      });
    },
    [clampOffset, getFitZoom],
  );

  /** Zoom about the centre of the viewport (used by the +/- buttons). */
  const zoomAtCenter = useCallback(
    (factor: number) => {
      const viewport = viewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      zoomAbout(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
    },
    [zoomAbout],
  );

  const handleWheel = useCallback(
    (event: WheelEvent) => {
      event.preventDefault();
      // Derive the zoom factor from the scroll magnitude rather than a fixed
      // step. Trackpads emit many small-delta events per gesture (and pinch via
      // ctrl+wheel), so a fixed step would zoom far too fast; an exponential of
      // the delta keeps the response smooth and proportional. The per-event
      // factor is clamped so no single event — e.g. a big mouse-wheel notch or
      // an aggressive swipe — can jump too far at once.
      const factor = Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY);
      const clampedFactor = Math.min(
        Math.max(factor, MIN_WHEEL_FACTOR),
        MAX_WHEEL_FACTOR,
      );
      zoomAbout(clampedFactor, event.clientX, event.clientY);
    },
    [zoomAbout],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    viewport?.addEventListener('wheel', handleWheel, { passive: false });
    return () => viewport?.removeEventListener('wheel', handleWheel);
  }, [handleWheel]);

  const beginPan = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      pointers.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      });
      event.currentTarget.setPointerCapture(event.pointerId);
      if (pointers.current.size === 2) {
        const [a, b] = [...pointers.current.values()];
        pinchDistance.current = Math.hypot(a.x - b.x, a.y - b.y);
        dragRef.current.mode = 'none';
        return;
      }
      dragRef.current = {
        mode: 'pan',
        startClientX: event.clientX,
        startClientY: event.clientY,
        startOffset: offset,
        travel: 0,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [offset],
  );

  const beginPinDrag = useCallback((event: React.PointerEvent<SVGGElement>) => {
    event.stopPropagation();
    viewportRef.current?.setPointerCapture(event.pointerId);
    dragRef.current = {
      mode: 'pin',
      startClientX: event.clientX,
      startClientY: event.clientY,
      startOffset: { x: 0, y: 0 },
      travel: 0,
    };
  }, []);

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (pointers.current.has(event.pointerId))
        pointers.current.set(event.pointerId, {
          x: event.clientX,
          y: event.clientY,
        });
      if (pointers.current.size >= 2) {
        const [a, b] = [...pointers.current.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDistance.current && distance > 0)
          zoomAbout(
            distance / pinchDistance.current,
            (a.x + b.x) / 2,
            (a.y + b.y) / 2,
          );
        pinchDistance.current = distance;
        return;
      }
      const drag = dragRef.current;
      if (drag.mode === 'none') return;

      const dx = event.clientX - drag.startClientX;
      const dy = event.clientY - drag.startClientY;
      drag.travel = Math.max(drag.travel, Math.hypot(dx, dy));

      if (drag.mode === 'pan') {
        const clamped = clampOffset(
          { x: drag.startOffset.x + dx, y: drag.startOffset.y + dy },
          zoom,
        );
        // Re-anchor the gesture to wherever the clamp actually landed. Without
        // this, dragging hard into a stop banks up slack that the user has to
        // drag back out before the plan moves again — the map would feel stuck
        // to the pointer on the way out of every edge.
        drag.startOffset = { x: clamped.x - dx, y: clamped.y - dy };
        setView((previous) => ({ ...previous, offset: clamped }));
        return;
      }

      const point = toImageCoords(event.clientX, event.clientY);
      if (point) onPinChange(point);
    },
    [clampOffset, onPinChange, toImageCoords, zoom, zoomAbout],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      pointers.current.delete(event.pointerId);
      if (pinchDistance.current !== null) {
        if (pointers.current.size === 0) pinchDistance.current = null;
        dragRef.current.mode = 'none';
        return;
      }
      const drag = dragRef.current;
      const wasClick = drag.mode === 'pan' && drag.travel <= CLICK_SLOP_PX;
      dragRef.current.mode = 'none';
      if (!wasClick) return;

      const point = toImageCoords(event.clientX, event.clientY);
      if (!point) return;
      if (authorMode) onAuthorClick(point);
      else onPinChange(point);
    },
    [authorMode, onAuthorClick, onPinChange, toImageCoords],
  );

  // Marker sizes are divided by zoom so they stay a constant size on screen —
  // otherwise the pin becomes a speck when zoomed out to fit.
  const markerScale = 1 / zoom;
  const routePoints = routeLeg?.points ?? [];
  const polyline = routePoints.map((p) => `${p.x},${p.y}`).join(' ');
  const connectors = nodes.filter(
    (n) => n.kind === 'elevator' || n.kind === 'stairs',
  );
  const destination = destNodeId
    ? nodes.find((n) => n.id === destNodeId)
    : undefined;

  return (
    <div className="floor-plan-viewer">
      {/* The map is a custom keyboard-operated canvas; its application role enables map shortcuts. */}
      {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
      <div
        ref={viewportRef}
        className="h-full w-full touch-none"
        style={{ cursor: authorMode ? 'crosshair' : 'grab' }}
        tabIndex={0}
        role="application"
        aria-label={`${floor.name} map. Use plus and minus to zoom, arrow keys to pan, or zero to fit.`}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (
            [
              '+',
              '=',
              '-',
              '0',
              'ArrowLeft',
              'ArrowRight',
              'ArrowUp',
              'ArrowDown',
            ].includes(event.key)
          )
            event.preventDefault();
          if (event.key === '+' || event.key === '=') zoomAtCenter(1.3);
          else if (event.key === '-') zoomAtCenter(1 / 1.3);
          else if (event.key === '0') fitToView();
          else if (event.key.startsWith('Arrow'))
            setView((previous) => ({
              ...previous,
              offset: clampOffset(
                {
                  x:
                    previous.offset.x +
                    (event.key === 'ArrowLeft'
                      ? 50
                      : event.key === 'ArrowRight'
                        ? -50
                        : 0),
                  y:
                    previous.offset.y +
                    (event.key === 'ArrowUp'
                      ? 50
                      : event.key === 'ArrowDown'
                        ? -50
                        : 0),
                },
                previous.zoom,
              ),
            }));
        }}
        onPointerDown={beginPan}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => {
          dragRef.current.mode = 'none';
          pointers.current.clear();
          pinchDistance.current = null;
        }}
      >
        <div
          ref={stageRef}
          className="relative origin-top-left bg-white"
          style={{
            width: floor.imageWidth,
            height: floor.imageHeight,
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
          }}
        >
          {planUrl && !imageFailed ? (
            <img
              src={planUrl}
              alt={`${floor.name} floor plan`}
              draggable={false}
              className="pointer-events-none absolute inset-0 h-full w-full select-none"
              onError={() => setImageFailed(true)}
            />
          ) : (
            // Schematic fallback: without a plan raster the graph itself is still
            // a usable map, so the page never degrades to a blank rectangle.
            <div className="absolute inset-0 bg-[var(--c3-style-basic-bg-secondary)]" />
          )}

          {nodes
            .filter(
              (node) =>
                node.kind === 'room' ||
                node.kind === 'entrance' ||
                node.kind === 'restroom',
            )
            .map((node) => (
              <button
                key={node.id}
                className={`map-room-marker ${destNodeId === node.id ? 'is-destination' : ''}`}
                style={{
                  left: node.imageX,
                  top: node.imageY,
                  transform: `translate(-50%, -50%) scale(${markerScale})`,
                }}
                aria-label={`Get directions to ${node.roomNumber ? `Room ${node.roomNumber}` : node.name}`}
                title={`${node.roomNumber ? `Room ${node.roomNumber}` : node.name} · ${floor.name}`}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onDestinationSelect?.(node);
                }}
              >
                {node.roomNumber || (node.kind === 'entrance' ? '↗' : 'WC')}
              </button>
            ))}
          <svg
            viewBox={`0 0 ${floor.imageWidth} ${floor.imageHeight}`}
            className="pointer-events-none absolute inset-0 z-[3] h-full w-full"
          >
            {/* Connector markers, so stairs and elevators are findable at a glance. */}
            {connectors.map((node) => (
              <g key={node.id}>
                <rect
                  x={node.imageX - 9 * markerScale}
                  y={node.imageY - 9 * markerScale}
                  width={18 * markerScale}
                  height={18 * markerScale}
                  rx={3 * markerScale}
                  fill={node.kind === 'elevator' ? '#1d4ed8' : '#6b7280'}
                  fillOpacity={0.85}
                />
                <text
                  x={node.imageX}
                  y={node.imageY + 4.5 * markerScale}
                  textAnchor="middle"
                  fill="#ffffff"
                  fontSize={12 * markerScale}
                  fontWeight={700}
                >
                  {node.kind === 'elevator' ? 'E' : 'S'}
                </text>
              </g>
            ))}

            {/* Route: a wide translucent casing under a solid line keeps it legible
                over dense black line art at any zoom. */}
            {routePoints.length > 1 && (
              <>
                <polyline
                  points={polyline}
                  fill="none"
                  stroke="#ffffff"
                  strokeOpacity={0.9}
                  strokeWidth={14 * markerScale}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <polyline
                  points={polyline}
                  fill="none"
                  stroke="#277663"
                  strokeWidth={7 * markerScale}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </>
            )}

            {routePoints.length > 0 && (
              <circle
                cx={routePoints[routePoints.length - 1].x}
                cy={routePoints[routePoints.length - 1].y}
                r={8 * markerScale}
                fill="#277663"
                stroke="#ffffff"
                strokeWidth={3 * markerScale}
              />
            )}

            {/* Destination highlight. */}
            {destination && (
              <circle
                cx={destination.imageX}
                cy={destination.imageY}
                r={15 * markerScale}
                fill="none"
                stroke="#dc2626"
                strokeWidth={4 * markerScale}
              />
            )}

            {/* GPS accuracy circle — drawn before the pin so the pin sits on top.
                Its size is the honest uncertainty of the fix, which indoors is
                usually wider than the room you are standing in. */}
            {pin && accuracyRadiusPx > 0 && (
              <circle
                cx={pin.x}
                cy={pin.y}
                r={accuracyRadiusPx}
                fill="#277663"
                fillOpacity={0.12}
                stroke="#277663"
                strokeOpacity={0.45}
                strokeWidth={2 * markerScale}
              />
            )}

            {pin && (
              <g
                className="pointer-events-auto cursor-grab"
                onPointerDown={beginPinDrag}
              >
                {/* Invisible, generously sized hit target: the visible dot is far
                    too small to grab reliably on a phone. */}
                <circle
                  cx={pin.x}
                  cy={pin.y}
                  r={26 * markerScale}
                  fill="transparent"
                />
                <circle
                  cx={pin.x}
                  cy={pin.y}
                  r={11 * markerScale}
                  fill="#277663"
                  stroke="#ffffff"
                  strokeWidth={4 * markerScale}
                />
              </g>
            )}
          </svg>
        </div>
      </div>

      {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
      {(imageFailed || !planUrl) && (
        <p className="map-image-error" role="alert">
          Floor plan image unavailable. Room positions are shown; reload to try
          again.
        </p>
      )}
      <div className="map-zoom-controls">
        <Button
          size="icon-md"
          variant="outline"
          appearance="secondary"
          aria-label="Zoom in"
          onClick={() => zoomAtCenter(1.3)}
        >
          <Plus className="size-4" aria-hidden />
        </Button>
        <Button
          size="icon-md"
          variant="outline"
          appearance="secondary"
          aria-label="Zoom out"
          onClick={() => zoomAtCenter(1 / 1.3)}
        >
          <Minus className="size-4" aria-hidden />
        </Button>
        <Button
          size="icon-md"
          variant="outline"
          appearance="secondary"
          aria-label="Fit floor plan to view"
          onClick={fitToView}
        >
          <Crosshair className="size-4" aria-hidden />
        </Button>
      </div>
    </div>
  );
}
