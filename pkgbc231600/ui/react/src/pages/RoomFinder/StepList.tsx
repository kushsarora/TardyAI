/**
 * The written directions for a vision route — one row per leg, in order.
 *
 * This is the component that still works when nothing else does. If a label
 * fails to resolve, the route is not drawable and the map disappears, but the
 * model's instructions are unaffected and are shown on their own. So the step
 * list never depends on geometry: it renders from `steps` alone, and treats the
 * floor attribution as decoration.
 *
 * Clicking a step moves the map to that floor. On a 2-D plan you cannot draw a
 * line between two storeys, so a floor change is expressed as "take S1 down to
 * floor 1" and the user follows it by changing the view — which makes these rows
 * the primary navigation control for a multi-floor route, not just a transcript.
 */

import React from 'react';
import { CornerDownRight, Footprints } from 'lucide-react';

interface StepListProps {
  /** The instructions, in travel order, exactly as the model wrote them. */
  steps: string[];
  /**
   * Floor each step applies to, parallel to {@link StepListProps.steps}.
   *
   * Server-derived and occasionally a guess, so an entry may be null. A row with
   * no attribution is still shown — it just is not clickable or highlighted.
   */
  stepFloorKeys?: (string | null)[];
  /** Floor currently on the map, so the relevant rows can be highlighted. */
  activeFloorKey: string | null;
  /** Jump the map to the floor a step happens on. */
  onFocusFloor: (floorKey: string) => void;
}

export default function StepList({ steps, stepFloorKeys, activeFloorKey, onFocusFloor }: StepListProps) {
  if (steps.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-[var(--c3-style-border-radius-8)] border border-[var(--c3-style-basic-border-weak)] bg-[var(--c3-style-basic-bg-primary)]">
      <div className="flex items-baseline gap-2 border-b border-[var(--c3-style-basic-border-weak)] px-3 py-2">
        <Footprints className="size-4 text-[var(--c3-style-accent-fg-strong)]" aria-hidden />
        <span className="text-c3-bold-body-p1 text-[var(--c3-style-basic-fg-primary)]">Directions</span>
        <span className="text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-secondary)]">
          {steps.length} {steps.length === 1 ? 'step' : 'steps'}
        </span>
      </div>

      <ol className="divide-y divide-[var(--c3-style-basic-border-weak)]">
        {steps.map((step, index) => {
          const floorKey = stepFloorKeys?.[index] ?? null;
          const isActive = floorKey !== null && floorKey === activeFloorKey;

          const body = (
            <>
              <span
                className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-c3-bold-label-l3 ${
                  isActive
                    ? 'bg-[var(--c3-style-accent-bg-strong)] text-[var(--c3-style-accent-fg-on-strong)]'
                    : 'bg-[var(--c3-style-basic-bg-secondary)] text-[var(--c3-style-basic-fg-secondary)]'
                }`}
              >
                {index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-c3-regular-body-p2 text-[var(--c3-style-basic-fg-primary)]">{step}</span>
                {floorKey && (
                  <span className="block text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-neutral)]">
                    Floor {floorKey}
                  </span>
                )}
              </span>
            </>
          );

          // Only a step with a known floor can move the map, so only that row
          // becomes a button — an inert <button> would promise an interaction
          // the component cannot deliver.
          return (
            <li key={`${index}-${step.slice(0, 24)}`}>
              {floorKey ? (
                <button
                  type="button"
                  onClick={() => onFocusFloor(floorKey)}
                  className={`flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-[var(--c3-style-basic-bg-hover)] ${
                    isActive ? 'bg-[var(--c3-style-accent-bg-weak)]' : ''
                  }`}
                >
                  {body}
                  <CornerDownRight
                    className="mt-1 size-4 shrink-0 text-[var(--c3-style-basic-fg-neutral)]"
                    aria-hidden
                  />
                </button>
              ) : (
                <div className="flex w-full items-start gap-3 px-3 py-2 text-left">{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
