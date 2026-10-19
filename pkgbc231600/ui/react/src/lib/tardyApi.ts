/**
 * Navigation over the bundled floor-plan circulation map.
 * C3 hosts the UI; it does not need Building/Floor/MapNode/NavEdge records.
 * The optional server provider must be selected explicitly.
 */

import { c3Action } from '@/c3Action';
import {
  Building,
  Floor,
  MapNode,
  NavGraphSnapshot,
  NavRoute,
} from '@/Interfaces';
import type { RouteLegWithSteps, RouteStep } from '@/lib/routeStepTypes';

// Hosting inside C3 must not silently select a nonexistent C3 map database.
// VITE_DATA_MODE and VITE_C3_ENV describe deployment, not map availability.
export const BUNDLED_MAP_MODE = import.meta.env.VITE_NAV_DATA_MODE !== 'server';
const action: typeof c3Action = async (type, method, args) => {
  if (!BUNDLED_MAP_MODE) return c3Action(type, method, args);
  const { mapAction } = await import('virtual:tardy-map');
  return mapAction(type, method, args);
};

/** The building mapped by the included floor-plan pictures. */
export const DEMO_BUILDING_ID = 'grainger';
const ROUTING_REVISION = 'grainger-access-v2';

/**
 * Coerce a C3 collection into a real JS array.
 *
 * The platform usually serializes a typed collection as a JSON array, but some
 * paths return it as an object keyed by numeric index instead. Normalizing once
 * at the boundary means no component has to care which it got — and means a
 * change in serialization cannot turn into a blank screen via `.map` on a
 * non-array.
 */
function toArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object')
    return Object.values(value as Record<string, T>);
  return [];
}

/**
 * Resolve a stored plan image path against the app's deployed base path.
 *
 * `Floor#planImageUrl` is authored root-relative (`/plans/floor_p3.png`), but
 * the app is served from a prefixed base (`/<env>/<app>/uiservice/` in dev),
 * where a root-relative URL would 404. Vite exposes the active base as
 * `BASE_URL`, so joining against it works in both dev and a built bundle.
 */
export function resolvePlanUrl(planImageUrl?: string | null): string | null {
  if (!planImageUrl) return null;
  if (/^https?:\/\//i.test(planImageUrl)) return planImageUrl;
  const base = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
  return `${base}${planImageUrl.startsWith('/') ? '' : '/'}${planImageUrl}`;
}

/** Load building details from the selected map provider. */
export async function fetchBuilding(
  buildingId: string = DEMO_BUILDING_ID,
): Promise<Building | null> {
  const response = await action('Building', 'fetch', {
    filter: `id == '${buildingId}'`,
    include: 'this',
    limit: 1,
  });
  const objs = toArray<Building>(response?.objs);
  return objs.length > 0 ? objs[0] : null;
}

/**
 * Load every floor of a building, lowest level first.
 *
 * `calibration` is a nested value collection, so it needs explicit dot-notation
 * includes — without them the floor arrives with no control points and the GPS
 * suggestion silently disables itself.
 */
export async function fetchFloors(
  buildingId: string = DEMO_BUILDING_ID,
): Promise<Floor[]> {
  const response = await action('Floor', 'fetch', {
    filter: `building.id == '${buildingId}'`,
    include:
      'this, building.id, calibration.points.lat, calibration.points.lon, ' +
      'calibration.points.imageX, calibration.points.imageY, calibration.points.label',
    order: 'level',
    limit: 50,
  });
  return toArray<Floor>(response?.objs);
}

/**
 * Load the whole navigation graph for a building in one call.
 *
 * Bounded deliberately: this is one mid-size building (674 nodes, 1356 edges),
 * so a single bulk load makes floor switching and marker rendering instant with
 * no further network traffic. It does NOT scale to every building on campus —
 * at that point this becomes a per-building lazy load.
 */
export async function fetchGraph(
  buildingId: string = DEMO_BUILDING_ID,
): Promise<NavGraphSnapshot> {
  const snapshot = await action('NavRouter', 'graphForBuilding', [buildingId]);
  if (
    buildingId === DEMO_BUILDING_ID &&
    (snapshot?.routingRevision !== ROUTING_REVISION ||
      !toArray(snapshot?.nodes).length)
  ) {
    throw new Error(
      'This building’s map needs an update before directions are available. Please contact the map administrator.',
    );
  }
  return {
    buildingId,
    nodes: toArray<MapNode>(snapshot?.nodes),
    edges: toArray(snapshot?.edges),
    nodeCount: snapshot?.nodeCount ?? 0,
    edgeCount: snapshot?.edgeCount ?? 0,
  };
}

/** Search a building's rooms by number, name or alias, ranked best-first. */
export async function searchRooms(
  query: string,
  buildingId: string = DEMO_BUILDING_ID,
  limit = 8,
): Promise<MapNode[]> {
  const results = await action('NavRouter', 'searchRooms', [
    buildingId,
    query,
    limit,
  ]);
  return toArray<MapNode>(results);
}

/** Normalize a raw route payload, hardening the collections against serialization drift. */
function normalizeRoute(raw: unknown): NavRoute {
  const route = (raw ?? {}) as NavRoute;
  return {
    ...route,
    found: !!route.found,
    legs: toArray<RouteLegWithSteps>(route.legs).map(
      (leg): RouteLegWithSteps => ({
        ...leg,
        points: toArray(leg.points),
        // Absent on an older server: keep it absent so the UI falls back to `instruction`.
        ...(leg.steps == null ? {} : { steps: toArray<RouteStep>(leg.steps) }),
      }),
    ),
    totalSeconds: route.totalSeconds ?? 0,
    floorsTraversed: route.floorsTraversed ?? 0,
    stepFree: !!route.stepFree,
  };
}

/**
 * Route between two known graph nodes.
 *
 * An unroutable request resolves successfully with `found: false` — it does not
 * reject. Only a transport or server fault throws.
 */
export async function findRoute(
  startNodeId: string,
  destNodeId: string,
  stepFree: boolean,
): Promise<NavRoute> {
  const route = await action('NavRouter', 'findRoute', [
    startNodeId,
    destNodeId,
    stepFree,
  ]);
  if (route?.routingRevision !== ROUTING_REVISION)
    throw new Error(
      'The navigation service needs the updated routing geometry.',
    );
  return normalizeRoute(route);
}

/** Snap a dropped pin to the nearest graph node on a floor. Null when the floor has no nodes. */
export async function nearestNode(
  floorId: string,
  imageX: number,
  imageY: number,
): Promise<MapNode | null> {
  const node = await action('NavRouter', 'nearestNode', [
    floorId,
    imageX,
    imageY,
  ]);
  return (node as MapNode) ?? null;
}
