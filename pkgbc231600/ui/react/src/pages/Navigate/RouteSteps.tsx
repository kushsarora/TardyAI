/**
 * Turn-by-turn panel: one row per floor the route passes through, each with
 * its numbered steps ("Turn right at 3110, then walk 12 m") when the server
 * sends them, and just the leg's one-line instruction when it does not.
 *
 * Clicking a step switches the map to that floor, which is the main way a
 * multi-floor route stays comprehensible — you cannot draw a line between two
 * floors on a 2-D plan, so the hand-off is expressed as "take Elevator A to
 * Level 3" and the user follows it by changing the view.
 */

import React from 'react';
import { ArrowDown, Footprints } from 'lucide-react';

import type { NavRoute } from '@/Interfaces';
import type { RouteLegWithSteps, RouteStep } from '@/lib/routeStepTypes';

interface RouteStepsProps {
  route: NavRoute;
  /** Floor currently shown on the map, so the matching step can be highlighted. */
  activeFloorId: string | null;
  onFocusFloor: (floorId: string) => void;
}

/** Render a duration the way a student reads it: seconds under a minute, else minutes. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  return `${Math.max(1, Math.round(seconds / 60))} min`;
}

/** Render a step distance in whole meters; any real walk shows at least 1 m. */
function formatMeters(meters: number): string {
  return `${Math.max(1, Math.round(meters))} m`;
}

/** The leg's turn-by-turn steps; empty when the server predates `RouteStep`. */
function stepsOf(leg: RouteLegWithSteps): RouteStep[] {
  return leg.steps ?? [];
}

/** Numbered turn-by-turn list for one leg, with each step's distance. */
function LegStepList({ steps, label }: { steps: RouteStep[]; label: string }) {
  return (
    <ol aria-label={label} className="ml-11 list-decimal space-y-1 pb-2 pr-3 marker:text-[var(--c3-style-basic-fg-neutral)]">
      {steps.map((step, index) => (
        <li
          key={`${step.kind}-${step.pointIndex}-${index}`}
          className="text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-primary)]"
        >
          <span>{step.text}</span>
          {step.meters > 0 && (
            <span className="ml-2 whitespace-nowrap text-[var(--c3-style-basic-fg-neutral)]">
              {formatMeters(step.meters)}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

export default function RouteSteps({ route, activeFloorId, onFocusFloor }: RouteStepsProps) {
  if (!route.found) {
    return (
      <div className="rounded-[var(--c3-style-border-radius-8)] border border-[var(--c3-style-danger-border-strong)] bg-[var(--c3-style-danger-bg-weak)] p-3">
        <p className="text-c3-bold-body-p2 text-[var(--c3-style-danger-fg-strong)]">No route</p>
        <p className="text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-secondary)]">
          {route.message ?? 'We could not find a way there.'}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-[var(--c3-style-border-radius-8)] border border-[var(--c3-style-basic-border-weak)] bg-[var(--c3-style-basic-bg-primary)]">
      <div className="flex items-baseline gap-2 border-b border-[var(--c3-style-basic-border-weak)] px-3 py-2">
        <Footprints className="size-4 text-[var(--c3-style-accent-fg-strong)]" aria-hidden />
        <span className="text-c3-bold-body-p1 text-[var(--c3-style-basic-fg-primary)]">
          {formatDuration(route.totalSeconds)}
        </span>
        <span className="text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-secondary)]">
          {route.totalMeters ? `${Math.round(route.totalMeters)} m` : ''}
          {route.floorsTraversed > 1 ? ` · ${route.floorsTraversed} floors` : ''}
          {route.stepFree ? ' · step-free' : ''}
        </span>
      </div>

      <ol className="divide-y divide-[var(--c3-style-basic-border-weak)]">
        {route.legs.map((leg: RouteLegWithSteps, index) => (
          <li key={`${leg.floorId}-${index}`}>
            <button
              type="button"
              onClick={() => onFocusFloor(leg.floorId)}
              className={`flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-[var(--c3-style-basic-bg-hover)] ${
                leg.floorId === activeFloorId ? 'bg-[var(--c3-style-accent-bg-weak)]' : ''
              }`}
            >
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--c3-style-accent-bg-strong)] text-c3-bold-label-l3 text-[var(--c3-style-accent-fg-on-strong)]">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-c3-regular-body-p2 text-[var(--c3-style-basic-fg-primary)]">
                  {leg.instruction}
                </span>
                <span className="block text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-neutral)]">
                  {leg.floorName ?? `Level ${leg.floorLevel}`}
                  {leg.seconds > 0 ? ` · ${formatDuration(leg.seconds)} walking` : ''}
                </span>
              </span>
              {index < route.legs.length - 1 && (
                <ArrowDown className="mt-1 size-4 shrink-0 text-[var(--c3-style-basic-fg-neutral)]" aria-hidden />
              )}
            </button>
            {stepsOf(leg).length > 0 && (
              <LegStepList
                steps={stepsOf(leg)}
                label={`Directions on ${leg.floorName ?? `Level ${leg.floorLevel}`}`}
              />
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
