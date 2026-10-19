/**
 * Convert a device GPS fix into a position in a floor plan's pixel space.
 *
 * This runs entirely client-side: the browser's Geolocation API gives lat/lon,
 * and a floor's authored {@link CalibrationPoint} list is enough to fit the
 * mapping. Nothing here needs a server round trip.
 *
 * ### What this is for, and what it is NOT for
 *
 * The result is a *suggestion* — a place to put the "I'm here" pin so the user
 * has less dragging to do. Indoors, a phone's fused fix is typically accurate to
 * 5–15 m, which is wider than most of the rooms we are routing between, so the
 * pin is always user-adjustable and the accuracy radius is always drawn. Do not
 * feed this straight into routing without letting the user confirm it.
 *
 * It also cannot tell you which **floor** the user is on. GPS vertical error is
 * roughly 1.5–3× its horizontal error (so 15–40 m indoors) against a floor
 * spacing of about 4 m, and no browser exposes a barometer — the Pressure
 * Sensor API never shipped in Safari or Chrome. The floor must be chosen by the
 * user. Every function here is strictly horizontal.
 */

import { CalibrationPoint } from '@/Interfaces';

/** Mean Earth radius in meters, used for the local planar projection. */
const EARTH_RADIUS_M = 6378137;

/** A point in a floor plan's pixel space. */
export interface PixelPoint {
  x: number;
  y: number;
}

/**
 * A fitted lat/lon → pixel mapping.
 *
 * `kind` records which model was used, because it changes how much you should
 * trust the output: `affine` can absorb the non-uniform scale and skew that
 * real architectural exports often have, `similarity` assumes the plan is a
 * pure rotation and uniform scale of the world.
 */
export interface GeoFit {
  kind: 'affine' | 'similarity';
  /** Pixels per real-world meter implied by the fit, averaged over both axes. */
  pixelsPerMeter: number;
  project: (lat: number, lon: number) => PixelPoint;
}

/**
 * Project lat/lon onto a local tangent plane in meters, centred on `(lat0, lon0)`.
 *
 * Over a single building (~200 m) the curvature error of this flat-Earth
 * approximation is well under a centimetre, which is four orders of magnitude
 * below the GPS noise we are trying to display. Latitude scaling of the
 * longitude axis is what keeps the plane from being stretched east-west.
 */
function toLocalMeters(lat: number, lon: number, lat0: number, lon0: number): PixelPoint {
  const latRad = (lat0 * Math.PI) / 180;
  const east = ((lon - lon0) * Math.PI) / 180 * EARTH_RADIUS_M * Math.cos(latRad);
  const north = ((lat - lat0) * Math.PI) / 180 * EARTH_RADIUS_M;
  return { x: east, y: north };
}

/**
 * Solve a small dense linear system `A·x = b` by Gaussian elimination with
 * partial pivoting. Returns null when the system is singular, which here means
 * the control points were collinear (or duplicated) and cannot define a plane.
 */
function solveLinearSystem(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m: number[][] = a.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    const tmp = m[col];
    m[col] = m[pivot];
    m[pivot] = tmp;

    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = m[row][col] / m[col][col];
      for (let k = col; k <= n; k += 1) m[row][k] -= factor * m[col][k];
    }
  }

  // Full Gauss-Jordan left the matrix diagonal, so each unknown is one division.
  return m.map((row, i) => row[n] / row[i]);
}

/**
 * Least-squares affine fit from 3 or more control points.
 *
 * Fits `px = a·east + b·north + c` and `py = d·east + e·north + f` by solving
 * the 3×3 normal equations for each axis independently. Six free parameters
 * means three points fit exactly and a fourth starts averaging out authoring
 * error — which is the main reason to prefer more than the minimum.
 */
function fitAffine(points: CalibrationPoint[], lat0: number, lon0: number): GeoFit | null {
  const local = points.map((p) => toLocalMeters(p.lat, p.lon, lat0, lon0));

  // Normal equations: sum of [east, north, 1]ᵀ·[east, north, 1].
  const ata = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const atx = [0, 0, 0];
  const aty = [0, 0, 0];

  for (let i = 0; i < points.length; i += 1) {
    const row = [local[i].x, local[i].y, 1];
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 3; c += 1) ata[r][c] += row[r] * row[c];
      atx[r] += row[r] * points[i].imageX;
      aty[r] += row[r] * points[i].imageY;
    }
  }

  const cx = solveLinearSystem(ata, atx);
  const cy = solveLinearSystem(ata, aty);
  if (!cx || !cy) return null;

  // Average the column norms of the 2x2 linear part to get a single scale.
  const scaleEast = Math.hypot(cx[0], cy[0]);
  const scaleNorth = Math.hypot(cx[1], cy[1]);

  return {
    kind: 'affine',
    pixelsPerMeter: (scaleEast + scaleNorth) / 2,
    project: (lat: number, lon: number) => {
      const p = toLocalMeters(lat, lon, lat0, lon0);
      return {
        x: cx[0] * p.x + cx[1] * p.y + cx[2],
        y: cy[0] * p.x + cy[1] * p.y + cy[2],
      };
    },
  };
}

/**
 * Exact similarity fit from exactly 2 control points.
 *
 * Two points give four equations for the four parameters of a similarity
 * (uniform scale, rotation, 2-D translation), so this is a closed-form solve
 * with nothing left over to validate against. The practical consequence: a
 * typo in either point silently produces a plausible-looking but wrong
 * mapping. Put the two points at **opposite corners** of the building — closely
 * spaced points divide by a small baseline and amplify any error in them.
 */
function fitSimilarity(points: CalibrationPoint[], lat0: number, lon0: number): GeoFit | null {
  const [p0, p1] = points;
  const a = toLocalMeters(p0.lat, p0.lon, lat0, lon0);
  const b = toLocalMeters(p1.lat, p1.lon, lat0, lon0);

  const worldDx = b.x - a.x;
  const worldDy = b.y - a.y;
  const worldLenSq = worldDx * worldDx + worldDy * worldDy;
  if (worldLenSq < 1e-6) return null; // The two points are the same place.

  const pixelDx = p1.imageX - p0.imageX;
  const pixelDy = p1.imageY - p0.imageY;

  // Complex division (pixel vector) / (world vector) yields scale·e^{iθ} in one step.
  const k = (pixelDx * worldDx + pixelDy * worldDy) / worldLenSq;
  const s = (pixelDy * worldDx - pixelDx * worldDy) / worldLenSq;

  const scale = Math.hypot(k, s);
  if (scale < 1e-9) return null;

  return {
    kind: 'similarity',
    pixelsPerMeter: scale,
    project: (lat: number, lon: number) => {
      const w = toLocalMeters(lat, lon, lat0, lon0);
      const dx = w.x - a.x;
      const dy = w.y - a.y;
      return {
        x: p0.imageX + k * dx - s * dy,
        y: p0.imageY + s * dx + k * dy,
      };
    },
  };
}

/**
 * Build a lat/lon → pixel mapping from a floor's control points.
 *
 * Picks the richest model the data supports: affine with 3+ points, similarity
 * with exactly 2. Returns null with fewer than 2 points, or when the points are
 * degenerate (collinear for affine, coincident for similarity) — callers should
 * treat null as "GPS suggestion unavailable" and let the user place the pin by
 * hand, which is the primary interaction regardless.
 */
export function fitGeoTransform(points?: CalibrationPoint[] | null): GeoFit | null {
  if (!points || points.length < 2) return null;

  // Centre the local projection on the control points to keep the numbers small.
  const lat0 = points.reduce((sum, p) => sum + p.lat, 0) / points.length;
  const lon0 = points.reduce((sum, p) => sum + p.lon, 0) / points.length;

  if (points.length >= 3) {
    const affine = fitAffine(points, lat0, lon0);
    // Collinear points make the affine normal equations singular; a similarity
    // fit from the two most separated of them still works, so fall back rather
    // than giving up on the suggestion entirely.
    if (affine) return affine;
    return fitSimilarity([points[0], points[points.length - 1]], lat0, lon0);
  }

  return fitSimilarity(points, lat0, lon0);
}

/**
 * Convert a GPS accuracy radius in meters into a radius in floor-plan pixels.
 *
 * Prefers the floor's authored scale, since that is measured against the plan
 * itself; falls back to the scale implied by the calibration fit. Returns 0 when
 * neither is available, which the UI renders as "no circle" rather than a
 * misleadingly tight one.
 */
export function accuracyRadiusInPixels(
  accuracyMeters: number | null | undefined,
  pixelsPerMeter: number | null | undefined,
  fit: GeoFit | null,
): number {
  if (!accuracyMeters || accuracyMeters <= 0) return 0;
  const scale = pixelsPerMeter && pixelsPerMeter > 0 ? pixelsPerMeter : fit?.pixelsPerMeter;
  if (!scale || scale <= 0) return 0;
  return accuracyMeters * scale;
}
