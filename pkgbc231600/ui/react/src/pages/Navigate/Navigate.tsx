/**
 * TardyAI — the main navigation screen.
 *
 * Owns all routing state and orchestrates the four pieces around it: the floor
 * plan map, the room search box, the turn-by-turn list, and the "will I be
 * late" card.
 *
 * ### How a route comes to exist
 *
 * 1. The user places the "I'm here" pin — by tapping the plan, or by letting
 *    the browser suggest a position from GPS.
 * 2. That pixel position is snapped to the nearest graph node server-side
 *    ({@link nearestNode}), because a route has to start *on* the graph.
 * 3. The user picks a destination from search.
 * 4. Start + destination + accessibility mode produce a route.
 *
 * Steps 2 and 4 are effects keyed on their inputs rather than click handlers,
 * so changing the accessibility toggle or nudging the pin re-routes without any
 * extra wiring — and so there is exactly one code path that can produce a
 * route.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Accessibility, Copy, LocateFixed, MapPin, Pencil, X } from 'lucide-react';

import { Building, Floor, MapNode, NavRoute } from '@/Interfaces';
import { PixelPoint, accuracyRadiusInPixels, fitGeoTransform } from '@/lib/geoTransform';
import { DEMO_BUILDING_ID, fetchBuilding, fetchFloors, fetchGraph, findRoute, nearestNode } from '@/lib/tardyApi';
import { useErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';
import { Button } from '@/components/ui/button';
import FloorPlanMap from '@/components/FloorPlan/FloorPlanMap';
import ArrivalCard from './ArrivalCard';
import RoomSearch from './RoomSearch';
import RouteSteps from './RouteSteps';

/** Debounce before a moved pin is snapped to the graph, to avoid a call per frame. */
const SNAP_DEBOUNCE_MS = 280;

/** Fallback accuracy when the browser reports a fix without one. */
const ASSUMED_ACCURACY_M = 15;

export default function Navigate() {
  const { reportError } = useErrorBoundary();

  const [building, setBuilding] = useState<Building | null>(null);
  const [floors, setFloors] = useState<Floor[]>([]);
  const [nodes, setNodes] = useState<MapNode[]>([]);
  const [loading, setLoading] = useState(true);

  const [activeFloorId, setActiveFloorId] = useState<string | null>(null);
  const [pin, setPin] = useState<PixelPoint | null>(null);
  const [pinFloorId, setPinFloorId] = useState<string | null>(null);
  const [startNode, setStartNode] = useState<MapNode | null>(null);
  const [destNode, setDestNode] = useState<MapNode | null>(null);
  const [stepFree, setStepFree] = useState(false);
  const [route, setRoute] = useState<NavRoute | null>(null);
  const [routing, setRouting] = useState(false);

  const [accuracyMeters, setAccuracyMeters] = useState<number | null>(null);
  const [locating, setLocating] = useState(false);
  const [locateMessage, setLocateMessage] = useState<string | null>(null);

  const [authorMode, setAuthorMode] = useState(false);
  const [authorPoint, setAuthorPoint] = useState<PixelPoint | null>(null);

  /* --------------------------------------------------------------------- *
   * Initial load: building, floors, and the whole navigation graph.
   * --------------------------------------------------------------------- */
  useEffect(() => {
    let cancelled = false;

    Promise.all([fetchBuilding(DEMO_BUILDING_ID), fetchFloors(DEMO_BUILDING_ID), fetchGraph(DEMO_BUILDING_ID)])
      .then(([loadedBuilding, loadedFloors, graph]) => {
        if (cancelled) return;
        setBuilding(loadedBuilding);
        setFloors(loadedFloors);
        setNodes(graph.nodes);

        const defaultLevel = loadedBuilding?.defaultFloorLevel;
        const preferred =
          loadedFloors.find((floor) => floor.level === defaultLevel) ?? loadedFloors[0] ?? null;
        setActiveFloorId(preferred ? preferred.id : null);
      })
      .catch((error) => {
        if (!cancelled) reportError(error);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [reportError]);

  const activeFloor = useMemo(
    () => floors.find((floor) => floor.id === activeFloorId) ?? null,
    [floors, activeFloorId],
  );

  const nodesOnActiveFloor = useMemo(
    () => nodes.filter((node) => node.floor?.id === activeFloorId),
    [nodes, activeFloorId],
  );

  /* --------------------------------------------------------------------- *
   * Snap the pin to the graph. Debounced because the pin moves continuously
   * while being dragged.
   * --------------------------------------------------------------------- */
  useEffect(() => {
    if (!pin || !pinFloorId) {
      setStartNode(null);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(() => {
      nearestNode(pinFloorId, pin.x, pin.y)
        .then((node) => {
          if (!cancelled) setStartNode(node);
        })
        .catch((error) => {
          if (!cancelled) reportError(error);
        });
    }, SNAP_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pin, pinFloorId, reportError]);

  /* --------------------------------------------------------------------- *
   * Recompute the route whenever its inputs change.
   * --------------------------------------------------------------------- */
  useEffect(() => {
    if (!startNode || !destNode) {
      setRoute(null);
      return;
    }

    let cancelled = false;
    setRouting(true);
    findRoute(startNode.id, destNode.id, stepFree)
      .then((result) => {
        if (cancelled) return;
        setRoute(result);
        // Jump the map to where the walk begins, so the drawn line is on screen.
        if (result.found && result.legs.length > 0) setActiveFloorId(result.legs[0].floorId);
      })
      .catch((error) => {
        if (!cancelled) reportError(error);
      })
      .finally(() => {
        if (!cancelled) setRouting(false);
      });

    return () => {
      cancelled = true;
    };
  }, [startNode, destNode, stepFree, reportError]);

  /* --------------------------------------------------------------------- *
   * Handlers
   * --------------------------------------------------------------------- */

  const handlePinChange = useCallback(
    (point: PixelPoint) => {
      try {
        setPin(point);
        setPinFloorId(activeFloorId);
        // A hand-placed pin is exact by definition, so drop the GPS uncertainty.
        setAccuracyMeters(null);
        setLocateMessage(null);
      } catch (error) {
        reportError(error);
      }
    },
    [activeFloorId, reportError],
  );

  /**
   * Ask the browser where we are and convert that to a pin position.
   *
   * The result is explicitly a *suggestion*: indoors the fix is typically good
   * to 5–15 m, which is wider than the rooms being navigated, so the accuracy
   * circle is drawn and the pin stays draggable. The floor is never inferred —
   * GPS altitude is nowhere near precise enough to tell storeys apart and no
   * browser exposes a barometer — so we locate onto whichever floor the user
   * has selected.
   */
  const handleLocate = useCallback(() => {
    if (!activeFloor) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocateMessage('This browser does not support location. Tap the map instead.');
      return;
    }

    const fit = fitGeoTransform(activeFloor.calibration?.points);
    if (!fit) {
      setLocateMessage('This floor has no GPS calibration yet. Tap the map to place your pin.');
      return;
    }

    setLocating(true);
    setLocateMessage(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        const projected = fit.project(position.coords.latitude, position.coords.longitude);
        const inside =
          projected.x >= 0 &&
          projected.y >= 0 &&
          projected.x <= activeFloor.imageWidth &&
          projected.y <= activeFloor.imageHeight;

        if (!inside) {
          setLocateMessage('You look like you are outside the building. Tap the map where you are.');
          return;
        }
        setPin(projected);
        setPinFloorId(activeFloor.id);
        setAccuracyMeters(position.coords.accuracy || ASSUMED_ACCURACY_M);
        setLocateMessage(`Suggested from GPS — drag the pin if it is off. You are on ${activeFloor.name}?`);
      },
      () => {
        setLocating(false);
        setLocateMessage('Could not get a location fix. Tap the map to place your pin.');
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
    );
  }, [activeFloor]);

  const handleCopyAuthorPoint = useCallback(() => {
    if (!authorPoint) return;
    const text = `${Math.round(authorPoint.x)}, ${Math.round(authorPoint.y)}`;
    navigator.clipboard?.writeText(text).catch((error) => reportError(error));
  }, [authorPoint, reportError]);

  const activeLeg = useMemo(() => {
    if (!route?.found) return null;
    return route.legs.find((leg) => leg.floorId === activeFloorId) ?? null;
  }, [route, activeFloorId]);

  const accuracyRadiusPx = useMemo(
    () =>
      accuracyRadiusInPixels(
        accuracyMeters,
        activeFloor?.pixelsPerMeter,
        fitGeoTransform(activeFloor?.calibration?.points),
      ),
    [accuracyMeters, activeFloor],
  );

  const destinationLabel = destNode ? destNode.roomNumber ?? destNode.name ?? destNode.id : null;

  /* --------------------------------------------------------------------- *
   * Render
   * --------------------------------------------------------------------- */

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="text-c3-regular-body-p2 text-[var(--c3-style-basic-fg-secondary)]">Loading floor plans…</p>
      </div>
    );
  }

  if (!activeFloor) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <p className="max-w-md text-c3-regular-body-p2 text-[var(--c3-style-basic-fg-secondary)]">
          No floors are loaded for this building yet. Seed the Building, Floor, MapNode and NavEdge data, then reload.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-3 lg:flex-row">
      {/* ---------------- Control panel ---------------- */}
      <aside className="flex w-full shrink-0 flex-col gap-3 overflow-y-auto lg:w-[360px]">
        <div>
          <h1 className="text-c3-bold-heading-h5 text-[var(--c3-style-basic-fg-primary)]">
            {building?.name ?? 'Indoor navigation'}
          </h1>
          <p className="text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-secondary)]">
            {building?.address ?? 'Pick a destination and we will get you there.'}
          </p>
        </div>

        <RoomSearch buildingId={DEMO_BUILDING_ID} onSelect={setDestNode} selectedLabel={destinationLabel} />

        {/* Start point */}
        <div className="rounded-[var(--c3-style-border-radius-8)] border border-[var(--c3-style-basic-border-weak)] bg-[var(--c3-style-basic-bg-primary)] p-3">
          <p className="mb-1 flex items-center gap-1.5 text-c3-bold-label-l3 text-[var(--c3-style-basic-fg-secondary)]">
            <MapPin className="size-4" aria-hidden />
            Where you are
          </p>
          <p className="text-c3-regular-body-p2 text-[var(--c3-style-basic-fg-primary)]">
            {startNode
              ? `Near ${startNode.roomNumber ?? startNode.name ?? startNode.kind}`
              : 'Tap the floor plan to drop your pin.'}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              appearance="secondary"
              loading={locating}
              onClick={handleLocate}
            >
              <LocateFixed className="size-3" aria-hidden />
              Use my location
            </Button>
            <Button
              size="sm"
              variant={stepFree ? 'solid' : 'outline'}
              appearance={stepFree ? 'accent' : 'secondary'}
              aria-pressed={stepFree}
              onClick={() => setStepFree((previous) => !previous)}
            >
              <Accessibility className="size-3" aria-hidden />
              Step-free
            </Button>
          </div>
          {locateMessage && (
            <p className="mt-2 text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-neutral)]">{locateMessage}</p>
          )}
        </div>

        <ArrivalCard routeSeconds={route?.found ? route.totalSeconds : null} />

        {routing && (
          <p className="text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-neutral)]">Finding the fastest way…</p>
        )}
        {route && !routing && (
          <RouteSteps route={route} activeFloorId={activeFloorId} onFocusFloor={setActiveFloorId} />
        )}

        {/* Author mode — the tool for correcting node coordinates in
            tools/build_graph.py without guessing. Not part of the student
            experience, but it is what makes the hand-authored graph fixable. */}
        <div className="rounded-[var(--c3-style-border-radius-8)] border border-dashed border-[var(--c3-style-basic-border-weak)] p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-c3-bold-label-l3 text-[var(--c3-style-basic-fg-secondary)]">
              <Pencil className="size-4" aria-hidden />
              Author mode
            </span>
            <Button
              size="sm"
              variant={authorMode ? 'solid' : 'ghost'}
              appearance={authorMode ? 'warning' : 'secondary'}
              aria-pressed={authorMode}
              onClick={() => {
                setAuthorMode((previous) => !previous);
                setAuthorPoint(null);
              }}
            >
              {authorMode ? 'On' : 'Off'}
            </Button>
          </div>
          {authorMode && (
            <div className="mt-2">
              <p className="text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-neutral)]">
                Click the plan to read off a pixel coordinate to paste into tools/build_graph.py.
              </p>
              {authorPoint && (
                <div className="mt-1 flex items-center gap-2">
                  <code className="rounded bg-[var(--c3-style-basic-bg-secondary)] px-2 py-1 text-c3-regular-body-p3 text-[var(--c3-style-basic-fg-primary)]">
                    {Math.round(authorPoint.x)}, {Math.round(authorPoint.y)}
                  </code>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    appearance="secondary"
                    aria-label="Copy coordinate"
                    onClick={handleCopyAuthorPoint}
                  >
                    <Copy className="size-3" aria-hidden />
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </aside>

      {/* ---------------- Map ---------------- */}
      <section className="relative flex min-h-[420px] flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-c3-bold-label-l3 text-[var(--c3-style-basic-fg-secondary)]">Floor</span>
          {/* Descending so the stack reads like a building elevation. */}
          {[...floors]
            .sort((a, b) => b.level - a.level)
            .map((floor) => {
              const onRoute = route?.found && route.legs.some((leg) => leg.floorId === floor.id);
              return (
                <Button
                  key={floor.id}
                  size="sm"
                  variant={floor.id === activeFloorId ? 'solid' : 'outline'}
                  appearance={floor.id === activeFloorId ? 'accent' : 'secondary'}
                  onClick={() => setActiveFloorId(floor.id)}
                >
                  {floor.name}
                  {onRoute && floor.id !== activeFloorId ? ' •' : ''}
                </Button>
              );
            })}
          {destNode && (
            <Button
              size="sm"
              variant="ghost"
              appearance="secondary"
              className="ml-auto"
              onClick={() => setDestNode(null)}
            >
              <X className="size-3" aria-hidden />
              Clear destination
            </Button>
          )}
        </div>

        <div className="min-h-0 flex-1">
          <FloorPlanMap
            floor={activeFloor}
            nodes={nodesOnActiveFloor}
            routeLeg={activeLeg}
            pin={pinFloorId === activeFloor.id ? pin : null}
            accuracyRadiusPx={accuracyRadiusPx}
            destNodeId={destNode?.id ?? null}
            authorMode={authorMode}
            onPinChange={handlePinChange}
            onAuthorClick={setAuthorPoint}
          />
        </div>
      </section>
    </div>
  );
}
