/**
 * The TardyAI hook: enter when class starts, find out whether you make it.
 *
 * This is the one piece of the app that answers the question a late student
 * actually has. Everything else answers "where is it" — this answers "am I
 * going to be late, and by how much".
 *
 * The verdict is a comparison of two clocks: `now + route duration` against the
 * class start time. Two honesty notes that are deliberately surfaced in the UI
 * rather than hidden:
 *
 * * The estimate assumes you start walking **now**. Standing still reading the
 *   screen makes it stale, so it recomputes on a timer.
 * * The route duration comes from authored edge costs and an assumed walking
 *   pace, so it is an estimate, not a measurement. It does not know about
 *   crowded stairwells between classes.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, CircleCheck, TriangleAlert } from 'lucide-react';

/**
 * How often the verdict is recomputed. One second would be wasted renders for a
 * number quoted in whole minutes; 15 s keeps "you have 3 min to spare" from
 * going stale while the student is standing in the lobby.
 */
const TICK_MS = 15000;

interface ArrivalCardProps {
  /** Total route duration in seconds, or null when there is no route yet. */
  routeSeconds: number | null;
}

/** Parse an `<input type="time">` value into today's date, or null if unset. */
function parseClassTime(value: string, now: Date): Date | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);
  return target;
}

export default function ArrivalCard({ routeSeconds }: ArrivalCardProps) {
  const [classTime, setClassTime] = useState('');
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const formatClock = useCallback(
    (date: Date) => date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
    [],
  );

  const verdict = useMemo(() => {
    if (routeSeconds === null) return null;
    const target = parseClassTime(classTime, now);
    if (!target) return null;

    const arrival = new Date(now.getTime() + routeSeconds * 1000);
    const slackMinutes = Math.round((target.getTime() - arrival.getTime()) / 60000);

    if (slackMinutes < 0) {
      return {
        late: true,
        headline: `Arrive ${Math.abs(slackMinutes)} min late`,
        detail: `Class starts at ${formatClock(target)}; you'd get there around ${formatClock(arrival)}.`,
      };
    }
    return {
      late: false,
      headline: slackMinutes === 0 ? 'Arrive right on time' : `You have ${slackMinutes} min to spare`,
      detail: `Leave now and you'd arrive around ${formatClock(arrival)}.`,
    };
  }, [classTime, now, routeSeconds, formatClock]);

  return (
    <div className="rounded-[var(--c3-style-border-radius-8)] border border-[var(--c3-style-basic-border-weak)] bg-[var(--c3-style-basic-bg-primary)] p-3">
      <label
        htmlFor="tardy-class-time"
        className="mb-1 flex items-center gap-1.5 text-c3-bold-label-l3 text-[var(--c3-style-basic-fg-secondary)]"
      >
        <CalendarClock className="size-4" aria-hidden />
        When does class start?
      </label>
      <input
        id="tardy-class-time"
        type="time"
        value={classTime}
        onChange={(event) => setClassTime(event.target.value)}
        className="h-[var(--c3-style-height-h-32)] w-full rounded-[var(--c3-style-border-radius-4)] border border-[var(--c3-style-basic-border-weak)] bg-[var(--c3-style-basic-bg-primary)] px-2 text-c3-regular-body-p2 text-[var(--c3-style-basic-fg-primary)] outline-none focus-visible:border-[var(--c3-style-accent-border-strong)]"
      />

      {verdict && (
        <div
          className={`mt-2 flex items-start gap-2 rounded-[var(--c3-style-border-radius-4)] p-2 ${
            verdict.late ? 'bg-[var(--c3-style-danger-bg-weak)]' : 'bg-[var(--c3-style-success-bg-weak)]'
          }`}
        >
          {verdict.late ? (
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--c3-style-danger-fg-strong)]" aria-hidden />
          ) : (
            <CircleCheck className="mt-0.5 size-4 shrink-0 text-[var(--c3-style-success-fg-strong)]" aria-hidden />
          )}
          <div>
            <p
              className={`text-c3-bold-body-p2 ${
                verdict.late
                  ? 'text-[var(--c3-style-danger-fg-strong)]'
                  : 'text-[var(--c3-style-success-fg-strong)]'
              }`}
            >
              {verdict.headline}
            </p>
            <p className="text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-secondary)]">{verdict.detail}</p>
          </div>
        </div>
      )}

      {routeSeconds === null && classTime.length > 0 && (
        <p className="mt-2 text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-neutral)]">
          Pick a destination and we&apos;ll tell you if you make it.
        </p>
      )}
    </div>
  );
}
