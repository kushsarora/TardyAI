/**
 * One floor of a vision route, drawn as an SVG polyline over the floor plan.
 *
 * ### Why a plain overlay works
 *
 * Both rasters of a floor — the clean plan the user sees and the labelled
 * render the model reads — are the same picture at different sizes, so they
 * share an aspect ratio. The `<svg>` declares its `viewBox` as the *original*
 * plan dimensions and is stretched over whichever image is showing, which means
 * a stored `imageX` / `imageY` lands in the right place without this component
 * knowing which raster it is sitting on, or how wide the page happens to be.
 *
 * ### The line is honest about what it is
 *
 * Segments are straight lines between points a human placed in corridors. It is
 * deliberately not wall-aware: it reads as a route without claiming to be a
 * geometrically validated path. Every point it joins came back from the server
 * having been resolved from a label, so nothing here was invented by the model.
 */

import React from 'react';

import { RouteFloorSegment, RouteWaypoint } from '@/Interfaces';
import { resolvePlanUrl } from '@/lib/roomFinderApi';

/*
 * Stroke widths and radii are in viewBox units, i.e. original-plan pixels, so
 * they stay visually constant whatever width the page gives the map. Tuned
 * against a ~1980px-wide plan shown around 900px: a 9-unit stroke reads as
 * roughly 4px on screen.
 */
const CASING_WIDTH = 18;
const LINE_WIDTH = 9;
const NODE_RADIUS = 13;
const END_RADIUS = 18;

interface FloorMapProps {
  /** The floor to draw, carrying the plan paths and the raster dimensions. */
  floor: RouteFloorSegment;
  /** The points walked on this floor, in travel order. */
  points: RouteWaypoint[];
  /**
   * Show the labelled render the model was given instead of the clean plan.
   *
   * This is the "show what the AI sees" view, and it is the whole argument for
   * trusting the route: the labels in the answer are visibly printed on the
   * picture the model read them off.
   */
  showAnnotated?: boolean;
}

export default function FloorMap({ floor, points, showAnnotated = false }: FloorMapProps) {
  const [imageFailed, setImageFailed] = React.useState(false);

  const planPath = showAnnotated ? floor.annotatedUrl : floor.planImageUrl;
  const planUrl = resolvePlanUrl(planPath);

  // Reset the failure latch when the source changes, so toggling the annotated
  // view can recover from one missing raster.
  React.useEffect(() => setImageFailed(false), [planUrl]);

  const polyline = points.map((point) => `${point.imageX},${point.imageY}`).join(' ');
  const start = points.length > 0 ? points[0] : null;
  const last = points.length > 0 ? points[points.length - 1] : null;

  return (
    <div
      className="relative w-full overflow-hidden rounded-[var(--c3-style-border-radius-8)] border border-[var(--c3-style-basic-border-weak)] bg-white"
      style={{ aspectRatio: `${floor.imageWidth} / ${floor.imageHeight}` }}
    >
      {planUrl && !imageFailed ? (
        <img
          src={planUrl}
          alt={`${floor.floorName ?? `Floor ${floor.floorLevel}`} plan`}
          draggable={false}
          className="absolute inset-0 h-full w-full select-none object-contain"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center bg-[var(--c3-style-basic-bg-secondary)] p-4 text-center">
          <p className="text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-neutral)]">
            Floor plan image is unavailable. The written directions below still apply.
          </p>
        </div>
      )}

      <svg
        viewBox={`0 0 ${floor.imageWidth} ${floor.imageHeight}`}
        className="pointer-events-none absolute inset-0 h-full w-full"
        role="img"
        aria-label={`Route across ${floor.floorName ?? `floor ${floor.floorLevel}`}`}
      >
        {/* A wide translucent casing under a solid line keeps the route legible
            over dense black line art and over the annotated render's labels. */}
        {points.length > 1 && (
          <>
            <polyline
              points={polyline}
              fill="none"
              stroke="#ffffff"
              strokeOpacity={0.92}
              strokeWidth={CASING_WIDTH}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <polyline
              points={polyline}
              fill="none"
              stroke="#2563eb"
              strokeWidth={LINE_WIDTH}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        )}

        {/* Intermediate corridor points: small ticks that show the route was
            assembled from real waypoints rather than drawn freehand. */}
        {points.slice(1, -1).map((point, index) => (
          <circle
            key={`${point.label}-${index}`}
            cx={point.imageX}
            cy={point.imageY}
            r={NODE_RADIUS * 0.55}
            fill="#2563eb"
            fillOpacity={0.9}
            stroke="#ffffff"
            strokeWidth={3}
          />
        ))}

        {/* Where this floor's walk begins. */}
        {start && (
          <circle
            cx={start.imageX}
            cy={start.imageY}
            r={NODE_RADIUS}
            fill="#ffffff"
            stroke="#2563eb"
            strokeWidth={6}
          />
        )}

        {/* Where it ends: a filled disc, ringed again when the user leaves the
            floor here, so a stair or lift transfer is distinguishable from the
            final destination at a glance. */}
        {last && points.length > 1 && (
          <>
            {last.isFloorChange && (
              <circle
                cx={last.imageX}
                cy={last.imageY}
                r={END_RADIUS + 9}
                fill="none"
                stroke="#f97316"
                strokeWidth={5}
                strokeDasharray="12 8"
              />
            )}
            <circle
              cx={last.imageX}
              cy={last.imageY}
              r={END_RADIUS}
              fill={last.isFloorChange ? '#f97316' : '#dc2626'}
              stroke="#ffffff"
              strokeWidth={5}
            />
          </>
        )}
      </svg>
    </div>
  );
}
