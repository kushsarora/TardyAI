/**
 * Typed wrappers over the Room Finder backend.
 *
 * Every call goes through `c3Action` to a static method on the `RoomFinder` C3
 * type, or to a built-in `fetch`. Keeping the transport here means the page
 * never has to know the FetchSpec shapes or the argument order of a C3 action.
 *
 * The one thing worth understanding before reading on: the model answers with
 * waypoint *labels*, and the server resolves them against the `Waypoint` table
 * before replying. So by the time a {@link VisionRoute} reaches this module its
 * geometry has already been validated — there is no coordinate in it that the
 * model invented.
 */

import { c3Action } from '@/c3Action';
import { BuildingFacts, RouteFloorSegment, RouteWaypoint, VisionRoute } from '@/Interfaces';
import { resolvePlanUrl } from '@/lib/tardyApi';

/** The building this build of the app demos. */
export const ROOM_FINDER_BUILDING_ID = 'grainger';

/** How many example chips the page offers. The spec asks for three. */
export const EXAMPLE_CHIP_COUNT = 3;

export { resolvePlanUrl };

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
  if (value && typeof value === 'object') return Object.values(value as Record<string, T>);
  return [];
}

/**
 * Harden one answer from the server against serialization drift.
 *
 * Three things are defended here, each of which would otherwise be a blank
 * screen rather than an error:
 *
 * - every nested collection is forced to an array (see {@link toArray});
 * - `drawable` is only allowed to stay true if there is actually a segment with
 *   two or more points to draw, so a malformed `ok` answer degrades to
 *   steps-only instead of rendering an empty SVG;
 * - `status` falls back to `error` rather than `undefined`, so the caller's
 *   `switch` can never fall through a hole.
 */
function normalizeRoute(raw: unknown): VisionRoute {
  const route = (raw ?? {}) as VisionRoute;

  const segments = toArray<RouteFloorSegment>(route.segments).map((segment) => ({
    ...segment,
    points: toArray<RouteWaypoint>(segment.points),
    stepIndexes: toArray<number>(segment.stepIndexes),
  }));

  const hasDrawableSegment = segments.some((segment) => segment.points.length > 1);

  return {
    ...route,
    status: route.status ?? 'error',
    drawable: !!route.drawable && hasDrawableSegment,
    route: toArray<RouteWaypoint>(route.route),
    segments,
    steps: toArray<string>(route.steps),
    stepFloorKeys: toArray<string | null>(route.stepFloorKeys),
    rawLabels: toArray<string>(route.rawLabels),
    retried: !!route.retried,
    source: route.source === 'cache' ? 'cache' : 'llm',
  };
}

/**
 * Ask the vision model for a route.
 *
 * Takes several seconds — the floor plans are served from the provider's prompt
 * cache, so the latency is almost entirely output generation. Show a loading
 * state for the whole duration.
 *
 * A model outage, an unparseable answer or a hallucinated label all resolve
 * successfully with `status: 'error'`; only a transport or server fault throws.
 * Blank input is a different matter: `message` is declared `!string`, so the
 * platform rejects an empty string before the method runs. Guard the input box.
 *
 * @param message the user's sentence, passed to the model verbatim
 * @param allowFallback replay a pinned answer if the model cannot be reached
 */
export async function findVisionRoute(
  message: string,
  allowFallback = true,
  buildingId: string = ROOM_FINDER_BUILDING_ID,
): Promise<VisionRoute> {
  return normalizeRoute(await c3Action('RoomFinder', 'findRoute', [buildingId, message, allowFallback]));
}

/**
 * Load the building's brief, which carries the curated example questions.
 *
 * `facts` is deliberately **not** included: it is a couple of kilobytes of
 * prose written for the model, not for a person, and the page only needs
 * `demoRoutes`. Returns null when the facts have not been seeded, which the
 * page surfaces as a setup warning rather than silently offering no examples.
 */
export async function fetchBuildingFacts(
  buildingId: string = ROOM_FINDER_BUILDING_ID,
): Promise<BuildingFacts | null> {
  const response = await c3Action('BuildingFacts', 'fetch', {
    filter: `building.id == '${buildingId}'`,
    include: 'id, demoRoutes, building.id',
    limit: 1,
  });
  const objs = toArray<BuildingFacts>(response?.objs);
  if (objs.length === 0) return null;
  return { ...objs[0], demoRoutes: toArray<string>(objs[0].demoRoutes) };
}

/**
 * Readiness report for the building — waypoints, plans, synced images, facts
 * and a reachable model.
 *
 * Worth calling on mount: every one of those failures produces a *useless*
 * route rather than an error, so finding out up front is much cheaper than
 * debugging a confidently wrong answer.
 */
export async function fetchDiagnostics(
  buildingId: string = ROOM_FINDER_BUILDING_ID,
): Promise<RoomFinderDiagnostics> {
  const raw = (await c3Action('RoomFinder', 'diagnostics', [buildingId])) ?? {};
  const report = raw as RoomFinderDiagnostics;
  return {
    ...report,
    ready: !!report.ready,
    problems: toArray<string>(report.problems),
    floors: toArray<RoomFinderFloorDiagnostic>(report.floors),
  };
}

/** Per-floor readiness detail inside {@link RoomFinderDiagnostics}. */
export interface RoomFinderFloorDiagnostic {
  floorKey: string;
  floorLevel: number;
  waypointCount?: number;
  /** False when the plan has not been copied into the C3 Filesystem yet. */
  imageReadable: boolean;
  syncedAt?: string | null;
}

/** Shape of `RoomFinder.diagnostics`, which is declared as loose `json`. */
export interface RoomFinderDiagnostics {
  ready: boolean;
  /** Anything missing, in the order it should be fixed. Empty when ready. */
  problems: string[];
  buildingId?: string;
  waypointCount?: number;
  distinctLabelCount?: number;
  planCount?: number;
  readablePlanCount?: number;
  factsPresent?: boolean;
  factsLength?: number;
  demoRouteCount?: number;
  pinnedAnswerCount?: number;
  completionClient?: string;
  completionClientReady?: boolean;
  supportsVision?: boolean;
  floors?: RoomFinderFloorDiagnostic[];
}
