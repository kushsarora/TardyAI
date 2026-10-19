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

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Crosshair, Minus, Plus } from 'lucide-react';

import { Floor, MapNode, RouteLeg } from '@/Interfaces';
import { PixelPoint } from '@/lib/geoTransform';
import { resolvePlanUrl } from '@/lib/tardyApi';
import { Button } from '@/components/ui/button';

const MIN_ZOOM = 0.08;
const MAX_ZOOM = 6;

/** Pointer travel, in screen px, above which a press is a pan and not a click. */
const CLICK_SLOP_PX = 4;

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
  onPinChange: (point: PixelPoint) => void;
  onAuthorClick: (point: PixelPoint) => void;
}

type DragMode = 'none' | 'pan' | 'pin';

export default function FloorPlanMap({
  floor,
  nodes,
  routeLeg,
  pin,
  accuracyRadiusPx,
  destNodeId,
  authorMode,
  onPinChange,
  onAuthorClick,
}: FloorPlanMapProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const [zoom, setZoom] = useState(0.4);
  const [offset, setOffset] = useState<PixelPoint>({ x: 0, y: 0 });
  const [imageFailed, setImageFailed] = useState(false);

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

  /** Scale and centre the plan so the whole floor is visible. */
  const fitToView = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || !floor.imageWidth || !floor.imageHeight) return;
    const { clientWidth, clientHeight } = viewport;
    if (clientWidth === 0 || clientHeight === 0) return;

    const next = Math.min(clientWidth / floor.imageWidth, clientHeight / floor.imageHeight) * 0.96;
    const clamped = Math.min(Math.max(next, MIN_ZOOM), MAX_ZOOM);
    setZoom(clamped);
    setOffset({
      x: (clientWidth - floor.imageWidth * clamped) / 2,
      y: (clientHeight - floor.imageHeight * clamped) / 2,
    });
  }, [floor.imageWidth, floor.imageHeight]);

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

      setZoom((previous) => {
        const next = Math.min(Math.max(previous * factor, MIN_ZOOM), MAX_ZOOM);
        const ratio = next / previous;
        setOffset((current) => ({
          x: anchorX - (anchorX - current.x) * ratio,
          y: anchorY - (anchorY - current.y) * ratio,
        }));
        return next;
      });
    },
    [],
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      event.preventDefault();
      zoomAbout(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX, event.clientY);
    },
    [zoomAbout],
  );

  const beginPan = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
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
      const drag = dragRef.current;
      if (drag.mode === 'none') return;

      const dx = event.clientX - drag.startClientX;
      const dy = event.clientY - drag.startClientY;
      drag.travel = Math.max(drag.travel, Math.hypot(dx, dy));

      if (drag.mode === 'pan') {
        setOffset({ x: drag.startOffset.x + dx, y: drag.startOffset.y + dy });
        return;
      }

      const point = toImageCoords(event.clientX, event.clientY);
      if (point) onPinChange(point);
    },
    [onPinChange, toImageCoords],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
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
  const connectors = nodes.filter((n) => n.kind === 'elevator' || n.kind === 'stairs');
  const destination = destNodeId ? nodes.find((n) => n.id === destNodeId) : undefined;

  return (
    <div className="relative h-full w-full overflow-hidden rounded-[var(--c3-style-border-radius-8)] border border-[var(--c3-style-basic-border-weak)] bg-[var(--c3-style-basic-bg-secondary)]">
      <div
        ref={viewportRef}
        className="h-full w-full touch-none"
        style={{ cursor: authorMode ? 'crosshair' : 'grab' }}
        onWheel={handleWheel}
        onPointerDown={beginPan}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
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

          <svg
            viewBox={`0 0 ${floor.imageWidth} ${floor.imageHeight}`}
            className="pointer-events-none absolute inset-0 h-full w-full"
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
                  stroke="#2563eb"
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
                fill="#2563eb"
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
                fill="#2563eb"
                fillOpacity={0.12}
                stroke="#2563eb"
                strokeOpacity={0.45}
                strokeWidth={2 * markerScale}
              />
            )}

            {pin && (
              <g className="pointer-events-auto cursor-grab" onPointerDown={beginPinDrag}>
                {/* Invisible, generously sized hit target: the visible dot is far
                    too small to grab reliably on a phone. */}
                <circle cx={pin.x} cy={pin.y} r={26 * markerScale} fill="transparent" />
                <circle
                  cx={pin.x}
                  cy={pin.y}
                  r={11 * markerScale}
                  fill="#16a34a"
                  stroke="#ffffff"
                  strokeWidth={4 * markerScale}
                />
              </g>
            )}
          </svg>
        </div>
      </div>

      <div className="absolute bottom-3 right-3 flex flex-col gap-1">
        <Button
          size="icon-md"
          variant="outline"
          appearance="secondary"
          aria-label="Zoom in"
          onClick={() => zoomAbout(1.3)}
        >
          <Plus className="size-4" aria-hidden />
        </Button>
        <Button
          size="icon-md"
          variant="outline"
          appearance="secondary"
          aria-label="Zoom out"
          onClick={() => zoomAbout(1 / 1.3)}
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
