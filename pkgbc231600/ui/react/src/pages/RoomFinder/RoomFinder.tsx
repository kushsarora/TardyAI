/**
 * Room Finder — ask for directions in a sentence, get a line drawn on the floor
 * plans.
 *
 * ### What this page is demonstrating
 *
 * There is no navigation graph behind it. The backend hands a vision model the
 * building's annotated floor plans and a page of prose, and the model answers
 * with the **waypoint labels** it read off the images. The server resolves those
 * labels against the `Waypoint` table before replying, so every coordinate this
 * page draws came out of the database — never out of the model. A hallucinated
 * label fails validation and degrades to written steps; a hallucinated
 * *coordinate* would have drawn a confident line through a wall, which is why
 * the model is never asked for one.
 *
 * That is also why the provenance strip at the bottom of the panel is not
 * decoration: it shows which labels were accepted, whether the one permitted
 * retry was used, and whether the answer came from the model or from a pinned
 * fallback. An audience is entitled to ask, and the page should be able to
 * answer without anyone opening a console.
 *
 * ### State
 *
 * One request at a time, one answer held at a time. The only derived state is
 * which floor segment is on the map — see the auto-advance effect, which walks
 * a multi-floor route for the viewer until they take over.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Compass, Info, MessageCircleQuestion, Route as RouteIcon, TriangleAlert } from 'lucide-react';

import { VisionRoute } from '@/Interfaces';
import {
  EXAMPLE_CHIP_COUNT,
  ROOM_FINDER_BUILDING_ID,
  RoomFinderDiagnostics,
  fetchBuildingFacts,
  fetchDiagnostics,
  findVisionRoute,
} from '@/lib/roomFinderApi';
import { useErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';
import {
  Alert,
  AlertAppearanceIcon,
  AlertContent,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import ChatInput from './ChatInput';
import FloorMap from './FloorMap';
import FloorTabs from './FloorTabs';
import StepList from './StepList';

/**
 * How long each floor of a multi-floor route is shown before the tabs advance.
 *
 * The point is that a cross-floor route is the interesting case and it is
 * invisible on a single 2-D plan — so the page walks it once, unprompted, and
 * then gets out of the way the moment the viewer touches a tab.
 */
const AUTO_ADVANCE_MS = 3600;

export default function RoomFinder() {
  const { reportError } = useErrorBoundary();

  const [examples, setExamples] = useState<string[]>([]);
  const [diagnostics, setDiagnostics] = useState<RoomFinderDiagnostics | null>(null);

  const [route, setRoute] = useState<VisionRoute | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);

  const [activeIndex, setActiveIndex] = useState(0);
  const [autoAdvance, setAutoAdvance] = useState(false);
  const [showAnnotated, setShowAnnotated] = useState(false);

  /* --------------------------------------------------------------------- *
   * Initial load: the example questions, and whether the building is even
   * able to answer. Both are tolerant of being absent — a missing readiness
   * report must not stop someone from asking a question.
   * --------------------------------------------------------------------- */
  useEffect(() => {
    let cancelled = false;

    Promise.all([
      fetchBuildingFacts(ROOM_FINDER_BUILDING_ID).catch(() => null),
      fetchDiagnostics(ROOM_FINDER_BUILDING_ID).catch(() => null),
    ])
      .then(([facts, report]) => {
        if (cancelled) return;
        setExamples((facts?.demoRoutes ?? []).slice(0, EXAMPLE_CHIP_COUNT));
        setDiagnostics(report);
      })
      .catch((error) => {
        if (!cancelled) reportError(error);
      });

    return () => {
      cancelled = true;
    };
  }, [reportError]);

  /* --------------------------------------------------------------------- *
   * Ask the model.
   * --------------------------------------------------------------------- */
  const handleSubmit = useCallback((message: string) => {
    setLoading(true);
    setRequestError(null);
    setRoute(null);
    setAsked(message);
    setActiveIndex(0);
    setAutoAdvance(false);

    findVisionRoute(message, true, ROOM_FINDER_BUILDING_ID)
      .then((answer) => {
        setRoute(answer);
        // Start at the floor the walk begins on, then walk the rest for the
        // viewer if there is more than one.
        setActiveIndex(0);
        setAutoAdvance(answer.drawable && answer.segments.length > 1);
      })
      .catch((error: unknown) => {
        // A transport or server fault, as distinct from the model failing to
        // answer — that comes back as status 'error' and is rendered below.
        setRequestError(
          typeof error === 'string' ? error : (error as Error)?.message ?? 'The request could not be completed.',
        );
      })
      .finally(() => setLoading(false));
  }, []);

  /* --------------------------------------------------------------------- *
   * Auto-advance through the floors of a multi-floor route, once.
   * --------------------------------------------------------------------- */
  useEffect(() => {
    if (!autoAdvance || !route) return;
    if (activeIndex >= route.segments.length - 1) {
      setAutoAdvance(false);
      return;
    }
    const timer = window.setTimeout(() => setActiveIndex((index) => index + 1), AUTO_ADVANCE_MS);
    return () => window.clearTimeout(timer);
  }, [autoAdvance, activeIndex, route]);

  /** Selecting a floor by hand is a takeover: stop advancing automatically. */
  const selectSegment = useCallback((index: number) => {
    setAutoAdvance(false);
    setActiveIndex(index);
  }, []);

  /** A step knows its floor key, not its segment; jump to that floor's first visit. */
  const focusFloorKey = useCallback(
    (floorKey: string) => {
      const index = route?.segments.findIndex((segment) => segment.floorKey === floorKey) ?? -1;
      if (index >= 0) selectSegment(index);
    },
    [route, selectSegment],
  );

  const segments = route?.drawable ? route.segments : [];
  const activeSegment = segments[activeIndex] ?? segments[0] ?? null;
  const activeFloorKey = activeSegment?.floorKey ?? null;

  /** The validated label chain, which is the whole trick made visible. */
  const labelChain = useMemo(
    () => (route?.route ?? []).map((point) => point.label).join(' → '),
    [route],
  );

  const cacheHitPercent =
    route?.promptTokens && route.cachedTokens !== undefined && route.promptTokens > 0
      ? Math.round((route.cachedTokens / route.promptTokens) * 100)
      : null;

  const setupProblems = diagnostics && !diagnostics.ready ? diagnostics.problems : [];

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3 lg:flex-row">
      {/* ---------------- Ask panel ---------------- */}
      <aside className="flex w-full shrink-0 flex-col gap-3 overflow-y-auto lg:w-[400px]">
        <div>
          <h1 className="flex items-center gap-2 text-c3-bold-heading-h5 text-[var(--c3-style-basic-fg-primary)]">
            <Compass className="size-5 text-[var(--c3-style-accent-fg-strong)]" aria-hidden />
            Room Finder
          </h1>
          <p className="text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-secondary)]">
            Describe where you are in plain English. A vision model reads the floor plans and we draw the
            route.
          </p>
        </div>

        {setupProblems.length > 0 && (
          <Alert variant="soft" appearance="warning">
            <AlertAppearanceIcon appearance="warning" />
            <AlertContent>
              <AlertTitle>This building is not ready yet</AlertTitle>
              <AlertDescription>{setupProblems[0]}</AlertDescription>
            </AlertContent>
          </Alert>
        )}

        <ChatInput
          onSubmit={handleSubmit}
          loading={loading}
          examples={examples}
          disabled={diagnostics !== null && !diagnostics.ready}
        />

        {asked && !loading && (
          <div className="rounded-[var(--c3-style-border-radius-8)] bg-[var(--c3-style-basic-bg-secondary)] px-3 py-2">
            <p className="text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-neutral)]">You asked</p>
            <p className="text-c3-regular-body-p2 text-[var(--c3-style-basic-fg-primary)]">{asked}</p>
          </div>
        )}

        {loading && (
          <div className="flex items-center gap-2.5 rounded-[var(--c3-style-border-radius-8)] border border-[var(--c3-style-basic-border-weak)] bg-[var(--c3-style-basic-bg-primary)] px-3 py-2.5">
            <Spinner size="md" tone="primary" label="Reading the floor plans" />
            <span className="text-c3-regular-body-p2 text-[var(--c3-style-basic-fg-primary)]">
              Reading the floor plans…
            </span>
          </div>
        )}

        {requestError && (
          <Alert variant="soft" appearance="destructive">
            <AlertAppearanceIcon appearance="destructive" />
            <AlertContent>
              <AlertTitle>Could not reach the server</AlertTitle>
              <AlertDescription>{requestError}</AlertDescription>
            </AlertContent>
          </Alert>
        )}

        {/* A question back is a success, not a failure — it is what stops a
            confidently wrong route, so it reads as the model talking. */}
        {route?.status === 'clarify' && (
          <div className="rounded-[var(--c3-style-border-radius-8)] border border-[var(--c3-style-accent-border-weak)] bg-[var(--c3-style-accent-bg-weak)] p-3">
            <p className="mb-1 flex items-center gap-1.5 text-c3-bold-label-l3 text-[var(--c3-style-accent-fg-strong)]">
              <MessageCircleQuestion className="size-4" aria-hidden />
              One question first
            </p>
            <p className="text-c3-regular-body-p2 text-[var(--c3-style-basic-fg-primary)]">
              {route.question ?? 'Could you say a bit more about where you are?'}
            </p>
          </div>
        )}

        {route?.status === 'error' && (
          <Alert variant="soft" appearance="destructive">
            <AlertAppearanceIcon appearance="destructive" />
            <AlertContent>
              <AlertTitle>No route</AlertTitle>
              <AlertDescription>
                {route.message ?? 'The model could not produce a usable answer. Try rephrasing.'}
              </AlertDescription>
            </AlertContent>
          </Alert>
        )}

        {/* The degraded case: usable instructions, but a label did not resolve,
            so there is nothing honest to draw. */}
        {route?.status === 'ok' && !route.drawable && (
          <Alert variant="soft" appearance="warning">
            <AlertAppearanceIcon appearance="warning" />
            <AlertContent>
              <AlertTitle>Directions only</AlertTitle>
              <AlertDescription>
                {route.message ??
                  'One of the waypoints could not be matched to the plans, so the route is written out rather than drawn.'}
              </AlertDescription>
            </AlertContent>
          </Alert>
        )}

        {route?.status === 'ok' && (
          <StepList
            steps={route.steps}
            stepFloorKeys={route.stepFloorKeys}
            activeFloorKey={activeFloorKey}
            onFocusFloor={focusFloorKey}
          />
        )}

        {/* ---------------- Provenance ---------------- */}
        {route && route.status !== 'error' && (
          <div className="rounded-[var(--c3-style-border-radius-8)] border border-dashed border-[var(--c3-style-basic-border-weak)] p-3">
            <p className="mb-2 flex items-center gap-1.5 text-c3-bold-label-l3 text-[var(--c3-style-basic-fg-secondary)]">
              <Info className="size-4" aria-hidden />
              How this answer was produced
            </p>

            <div className="mb-2 flex flex-wrap gap-1.5">
              <Badge variant="soft" appearance={route.source === 'cache' ? 'warning' : 'success'} size="sm">
                {route.source === 'cache' ? 'Pinned fallback' : 'Live model'}
              </Badge>
              {route.retried && (
                <Badge variant="soft" appearance="warning" size="sm">
                  Self-corrected after 1 retry
                </Badge>
              )}
              {route.latencyMs !== undefined && route.latencyMs > 0 && (
                <Badge variant="outline" appearance="secondary" size="sm">
                  {(route.latencyMs / 1000).toFixed(1)}s
                </Badge>
              )}
              {cacheHitPercent !== null && (
                <Badge variant="outline" appearance="secondary" size="sm">
                  {cacheHitPercent}% prompt cached
                </Badge>
              )}
            </div>

            {labelChain && (
              <p className="break-words text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-neutral)]">
                <span className="text-[var(--c3-style-basic-fg-secondary)]">Waypoints validated:</span>{' '}
                <code className="text-[var(--c3-style-basic-fg-primary)]">{labelChain}</code>
              </p>
            )}
            {route.validationError && (
              <p className="mt-1 flex items-start gap-1.5 text-c3-regular-body-p3 text-[var(--c3-style-warning-fg-strong)]">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                First attempt rejected: {route.validationError}
              </p>
            )}
            {route.modelName && (
              <p className="mt-1 text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-neutral)]">
                {route.modelName}
              </p>
            )}
          </div>
        )}
      </aside>

      {/* ---------------- Map ---------------- */}
      <section className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
        {activeSegment ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <FloorTabs segments={segments} activeIndex={activeIndex} onSelect={selectSegment} />
              <div className="flex items-center gap-2">
                <label
                  htmlFor="show-annotated"
                  className="text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-secondary)]"
                >
                  Show what the AI sees
                </label>
                <Switch
                  id="show-annotated"
                  size="md"
                  checked={showAnnotated}
                  onCheckedChange={setShowAnnotated}
                />
              </div>
            </div>

            <FloorMap floor={activeSegment} points={activeSegment.points} showAnnotated={showAnnotated} />

            <p className="text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-neutral)]">
              {showAnnotated
                ? 'This is the labelled plan the model was given. Every waypoint in the answer is printed on it — the model replies with these labels, never with coordinates.'
                : 'The line joins waypoints a human placed in the corridors, so it shows the way without claiming to be a wall-aware path.'}
            </p>
          </>
        ) : (
          <div className="flex h-full min-h-[320px] flex-col items-center justify-center gap-2 rounded-[var(--c3-style-border-radius-8)] border border-dashed border-[var(--c3-style-basic-border-weak)] p-8 text-center">
            <RouteIcon className="size-8 text-[var(--c3-style-basic-fg-neutral)]" aria-hidden />
            <p className="max-w-sm text-c3-regular-body-p2 text-[var(--c3-style-basic-fg-secondary)]">
              {loading
                ? 'Reading the floor plans…'
                : route?.status === 'clarify'
                  ? 'Answer the question on the left and ask again.'
                  : 'Ask a question and the route will be drawn here.'}
            </p>
            {diagnostics?.ready && (
              <p className="text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-neutral)]">
                {diagnostics.planCount} floors mapped · {diagnostics.waypointCount} waypoints
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
