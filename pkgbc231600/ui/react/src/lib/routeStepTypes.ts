/**
 * Turn-by-turn step types. Mirror `RouteStep.c3typ` and the `steps` field of
 * `RouteLeg.c3typ`.
 *
 * Kept outside `Interfaces.tsx` so this feature can land without editing that
 * shared file; `RouteLegWithSteps` widens the existing `RouteLeg` instead.
 */

import type { RouteLeg } from '@/Interfaces';

/** What a step is; see `RouteStep.c3typ` for each kind's meaning. */
export type RouteStepKind = 'start' | 'straight' | 'turn' | 'connector' | 'arrive';

/** One followable direction within a leg. Mirrors `RouteStep`. */
export interface RouteStep {
  kind: RouteStepKind;
  /** Display-ready text, e.g. "Turn right at 3110, then walk 12 m". */
  text: string;
  meters: number;
  seconds: number;
  /** Index into the leg's `points` where this step begins. */
  pointIndex: number;
}

/**
 * A leg as the server now returns it. `steps` is absent from a server or
 * tenant that predates `RouteStep`; the UI then falls back to `instruction`.
 */
export type RouteLegWithSteps = RouteLeg & { steps?: RouteStep[] };
