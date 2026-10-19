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

import React, {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  Accessibility,
  ArrowDownUp,
  ArrowRight,
  ArrowUpRight,
  Bookmark,
  Box,
  Building2,
  Check,
  ChevronRight,
  DoorOpen,
  GraduationCap,
  Info,
  Layers,
  Loader2,
  LocateFixed,
  MapPin,
  Map,
  Navigation,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';

import { Building, Floor, MapNode, NavRoute } from '@/Interfaces';
import {
  PixelPoint,
  accuracyRadiusInPixels,
  fitGeoTransform,
} from '@/lib/geoTransform';
import {
  DEMO_BUILDING_ID,
  fetchBuilding,
  fetchFloors,
  fetchGraph,
  findRoute,
  nearestNode,
} from '@/lib/tardyApi';
import { useErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';
import FloorPlanMap from '@/components/FloorPlan/FloorPlanMap';
import ArrivalCard from './ArrivalCard';
import RoomSearch from './RoomSearch';
import RouteSteps from './RouteSteps';

const Building3DMap = lazy(
  () => import('@/components/Building3D/Building3DMap'),
);

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
  const [mapView, setMapView] = useState<'2d' | '3d'>(() => {
    try {
      return localStorage.getItem('tardy.map-view') === '3d' ? '3d' : '2d';
    } catch {
      return '2d';
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('tardy.map-view', mapView);
    } catch {
      /* The view toggle also works without browser storage. */
    }
  }, [mapView]);

  const [activeFloorId, setActiveFloorId] = useState<string | null>(null);
  const [pin, setPin] = useState<PixelPoint | null>(null);
  const [selectedStartId, setSelectedStartId] = useState<string | null>(null);
  const [pinFloorId, setPinFloorId] = useState<string | null>(null);
  const [startNode, setStartNode] = useState<MapNode | null>(null);
  const [destNode, setDestNode] = useState<MapNode | null>(null);
  const [stepFree, setStepFree] = useState(false);
  const [route, setRoute] = useState<NavRoute | null>(null);
  const [routing, setRouting] = useState(false);

  const [accuracyMeters, setAccuracyMeters] = useState<number | null>(null);
  const [locating, setLocating] = useState(false);
  const [locateMessage, setLocateMessage] = useState<string | null>(null);

  const location = useLocation();
  const navigate = useNavigate();
  const [loadError, setLoadError] = useState('');
  const [routeError, setRouteError] = useState('');
  const [retry, setRetry] = useState(0);
  const [category, setCategory] = useState('all');
  const [directoryQuery, setDirectoryQuery] = useState('');
  const [saved, setSaved] = useState<string[]>(() => {
    try {
      const value = JSON.parse(localStorage.getItem('tardy.saved') || '[]');
      return Array.isArray(value)
        ? value.filter((id) => typeof id === 'string')
        : [];
    } catch {
      return [];
    }
  });
  const [storageMessage, setStorageMessage] = useState('');
  const [guiding, setGuiding] = useState(false);
  const [guideIndex, setGuideIndex] = useState(0);
  const toggleSaved = (id: string) =>
    setSaved((previous) => {
      const next = previous.includes(id)
        ? previous.filter((item) => item !== id)
        : [...previous, id];
      try {
        localStorage.setItem('tardy.saved', JSON.stringify(next));
      } catch {
        setStorageMessage(
          'Saved for this session. Your browser has disabled storage.',
        );
      }
      return next;
    });

  /* --------------------------------------------------------------------- *
   * Initial load: building, floors, and the whole navigation graph.
   * --------------------------------------------------------------------- */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');

    Promise.all([
      fetchBuilding(DEMO_BUILDING_ID),
      fetchFloors(DEMO_BUILDING_ID),
      fetchGraph(DEMO_BUILDING_ID),
    ])
      .then(([loadedBuilding, loadedFloors, graph]) => {
        if (cancelled) return;
        setBuilding(loadedBuilding);
        setFloors(loadedFloors);
        setNodes(graph.nodes);

        const defaultLevel = loadedBuilding?.defaultFloorLevel;
        const preferred =
          loadedFloors.find((floor) => floor.level === defaultLevel) ??
          loadedFloors[0] ??
          null;
        setActiveFloorId(preferred ? preferred.id : null);
      })
      .catch((error) => {
        if (!cancelled)
          setLoadError(
            error instanceof Error
              ? error.message
              : 'Could not load the building. Check your connection and try again.',
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [reportError, retry]);

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

    if (selectedStartId) {
      const selected = nodes.find((node) => node.id === selectedStartId);
      if (selected) {
        setStartNode(selected);
        return;
      }
    }
    setStartNode(null);
    setRoute(null);
    setRouteError('');
    let cancelled = false;
    const timer = window.setTimeout(() => {
      nearestNode(pinFloorId, pin.x, pin.y)
        .then((node) => {
          if (!cancelled) setStartNode(node);
        })
        .catch(() => {
          if (!cancelled)
            setRouteError(
              'Could not set your starting point. Try selecting a nearby room.',
            );
        });
    }, SNAP_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pin, pinFloorId, selectedStartId, nodes, reportError]);

  /* --------------------------------------------------------------------- *
   * Recompute the route whenever its inputs change.
   * --------------------------------------------------------------------- */
  useEffect(() => {
    if (!startNode || !destNode) {
      setRoute(null);
      setRouting(false);
      return;
    }

    let cancelled = false;
    setRouting(true);
    setRoute(null);
    setRouteError('');
    setGuiding(false);
    setGuideIndex(0);
    findRoute(startNode.id, destNode.id, stepFree)
      .then((result) => {
        if (cancelled) return;
        setRoute(result);
        // Jump the map to where the walk begins, so the drawn line is on screen.
        if (result.found && result.legs.length > 0)
          setActiveFloorId(result.legs[0].floorId);
      })
      .catch(() => {
        if (!cancelled) {
          setRoute(null);
          setRouteError(
            'Could not calculate your route. Move your pin or choose your destination again.',
          );
        }
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
        setSelectedStartId(null);
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
      setLocateMessage(
        'This browser does not support location. Tap the map instead.',
      );
      return;
    }

    const fit = fitGeoTransform(activeFloor.calibration?.points);
    if (!fit) {
      setLocateMessage(
        'This floor has no GPS calibration yet. Tap the map to place your pin.',
      );
      return;
    }

    setLocating(true);
    setLocateMessage(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        const projected = fit.project(
          position.coords.latitude,
          position.coords.longitude,
        );
        const inside =
          projected.x >= 0 &&
          projected.y >= 0 &&
          projected.x <= activeFloor.imageWidth &&
          projected.y <= activeFloor.imageHeight;

        if (!inside) {
          setLocateMessage(
            'You look like you are outside the building. Tap the map where you are.',
          );
          return;
        }
        setSelectedStartId(null);
        setPin(projected);
        setPinFloorId(activeFloor.id);
        setAccuracyMeters(position.coords.accuracy || ASSUMED_ACCURACY_M);
        setLocateMessage(
          `Suggested from GPS — drag the pin if it is off. You are on ${activeFloor.name}?`,
        );
      },
      () => {
        setLocating(false);
        setLocateMessage(
          'Could not get a location fix. Tap the map to place your pin.',
        );
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 },
    );
  }, [activeFloor]);

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

  const chooseDestination = (node: MapNode) => {
    setDestNode(node);
    setActiveFloorId(node.floor.id);
    setGuiding(false);
  };
  const chooseStart = (node: MapNode) => {
    setSelectedStartId(node.id);
    setPin({ x: node.imageX, y: node.imageY });
    setPinFloorId(node.floor.id);
    setActiveFloorId(node.floor.id);
    setAccuracyMeters(null);
    setLocateMessage(null);
  };
  const swapEndpoints = () => {
    if (!startNode || !destNode) return;
    chooseStart(destNode);
    chooseDestination(startNode);
  };
  const rooms = nodes.filter((node) =>
    ['room', 'restroom', 'entrance'].includes(node.kind),
  );
  const popular = rooms
    .filter((node) => node.name && !/^(Class\s+)?Room \d/i.test(node.name))
    .slice(0, 4);
  const directory = rooms.filter((node) => {
    const matchesQuery =
      `${node.roomNumber || ''} ${node.name || ''} ${node.searchAliases || ''}`
        .toLowerCase()
        .includes(directoryQuery.toLowerCase());
    return (
      matchesQuery &&
      (location.pathname !== '/saved' || saved.includes(node.id)) &&
      (category === 'all' ||
        (category === 'rooms' ? node.kind === 'room' : node.kind === category))
    );
  });
  const isDirectory = ['/directory', '/saved'].includes(location.pathname);
  const guideLeg = route?.found ? route.legs[guideIndex] : null;

  if (loading)
    return (
      <div className="loading-page">
        <span className="loading-symbol">
          <Navigation size={28} />
        </span>
        <h2>Getting your bearings.</h2>
        <p>Loading Grainger Hall’s maps and rooms…</p>
        <Loader2 className="animate-spin" size={20} />
      </div>
    );
  if (loadError || !activeFloor)
    return (
      <div className="loading-page">
        <Building2 size={36} />
        <h2>We couldn’t load this building.</h2>
        <p>{loadError || 'No floor plans are available yet.'}</p>
        <button
          className="primary-button"
          onClick={() => setRetry((value) => value + 1)}
        >
          Try again
        </button>
      </div>
    );

  return (
    <div className="navigation-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            <span /> FIND YOUR WAY, INSIDE.
          </div>
          <h1>
            {isDirectory
              ? location.pathname === '/saved'
                ? 'Your go-to places.'
                : 'A place for every class.'
              : 'Less searching. More arriving.'}
          </h1>
          <p>
            {isDirectory
              ? 'Every mapped room and useful spot in Grainger Hall, in one place.'
              : 'Find your classroom. Take the right turn. Get there on time.'}
          </p>
        </div>
        <div className="building-selector">
          <span className="building-icon">
            <Building2 size={22} />
          </span>
          <span>
            <small>YOU’RE EXPLORING</small>
            <strong>{building?.name || 'Grainger Hall'}</strong>
            <em>UW–Madison · {floors.length} mapped floors</em>
          </span>
        </div>
      </div>

      {location.pathname === '/help' && (
        <section className="help-panel">
          <div>
            <span className="eyebrow">A LITTLE DIRECTION</span>
            <h2>Your next class, without the guesswork.</h2>
          </div>
          <ol>
            <li>
              <strong>1. Choose your starting point</strong>
              <p>
                Search for a nearby room or entrance, or tap your position on
                the floor plan. Select your floor first.
              </p>
            </li>
            <li>
              <strong>2. Find your destination</strong>
              <p>
                Search by room number, name, or a term like “restroom”. Switch
                on step-free routing to use elevators.
              </p>
            </li>
            <li>
              <strong>3. Follow your route</strong>
              <p>
                Start directions and use the floor controls as you walk. Add
                today’s class time to check your estimated arrival.
              </p>
            </li>
          </ol>
          <p className="data-note">
            <Info size={16} /> Routes use an approximate, hand-authored building
            graph. GPS cannot identify your floor. Follow posted signs and
            building access restrictions.
          </p>
          <button className="primary-button" onClick={() => navigate('/')}>
            Explore the map <ArrowRight size={17} />
          </button>
        </section>
      )}

      {isDirectory ? (
        <section className="directory-panel">
          <div className="directory-toolbar">
            <div className="search-field">
              <Search size={18} />
              <input
                aria-label="Search directory"
                placeholder="Search rooms, names, or places…"
                value={directoryQuery}
                onChange={(event) => setDirectoryQuery(event.target.value)}
              />
            </div>
            <span>{directory.length} places</span>
          </div>
          <div className="filter-chips">
            {[
              ['all', 'All places'],
              ['rooms', 'Rooms'],
              ['restroom', 'Restrooms'],
              ['entrance', 'Entrances'],
            ].map(([value, label]) => (
              <button
                key={value}
                className={category === value ? 'selected' : ''}
                onClick={() => setCategory(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="room-grid">
            {directory.map((node) => (
              <article className="directory-card" key={node.id}>
                <div className="directory-card-top">
                  <span className="place-icon">
                    {node.kind === 'room' ? (
                      <GraduationCap size={22} />
                    ) : (
                      <DoorOpen size={22} />
                    )}
                  </span>
                  <button
                    className={`icon-button ${saved.includes(node.id) ? 'is-saved' : ''}`}
                    aria-label={`${saved.includes(node.id) ? 'Unsave' : 'Save'} ${node.roomNumber || node.name}`}
                    aria-pressed={saved.includes(node.id)}
                    onClick={() => toggleSaved(node.id)}
                  >
                    <Bookmark
                      size={18}
                      fill={saved.includes(node.id) ? 'currentColor' : 'none'}
                    />
                  </button>
                </div>
                <h3>
                  {node.roomNumber ? `Room ${node.roomNumber}` : node.name}
                </h3>
                <p>{node.roomNumber ? node.name : node.kind}</p>
                <div className="directory-card-bottom">
                  <span>
                    <Layers size={13} /> {node.floor?.name}
                  </span>
                  <button
                    onClick={() => {
                      chooseDestination(node);
                      navigate('/');
                    }}
                  >
                    Get directions <ArrowUpRight size={15} />
                  </button>
                </div>
              </article>
            ))}
          </div>
          {!directory.length && (
            <div className="directory-empty">
              <Bookmark size={28} />
              <h3>
                {location.pathname === '/saved'
                  ? 'Keep your favorite places close.'
                  : 'No places found.'}
              </h3>
              <p>
                {location.pathname === '/saved'
                  ? 'Save rooms from the directory to find them here.'
                  : 'Try another room number or clear your filters.'}
              </p>
              <button
                className="secondary-button"
                onClick={() => {
                  navigate('/directory');
                  setDirectoryQuery('');
                  setCategory('all');
                }}
              >
                Browse all rooms
              </button>
            </div>
          )}
          {storageMessage && <p role="status">{storageMessage}</p>}
        </section>
      ) : (
        location.pathname !== '/help' && (
          <>
            <div className="map-workspace">
              <aside className="journey-panel">
                <div className="panel-title">
                  <span className="section-icon">
                    <Navigation size={19} />
                  </span>
                  <div>
                    <h2>Let’s get you there</h2>
                    <p>A little direction goes a long way.</p>
                  </div>
                </div>
                <div className="journey-fields">
                  <span className="endpoint-line" />
                  <div className="endpoint-row">
                    <span className="endpoint-dot start-dot" />
                    <RoomSearch
                      buildingId={DEMO_BUILDING_ID}
                      onSelect={chooseStart}
                      label="STARTING POINT"
                      selectedLabel={
                        startNode
                          ? startNode.roomNumber
                            ? `Room ${startNode.roomNumber}`
                            : startNode.name || 'Your map pin'
                          : pin
                            ? 'Locating your map pin…'
                            : null
                      }
                      placeholder="Choose a room or tap the map"
                    />
                  </div>
                  <button
                    className="swap-button"
                    aria-label="Swap start and destination"
                    disabled={!startNode || !destNode}
                    onClick={swapEndpoints}
                  >
                    <ArrowDownUp size={14} />
                  </button>
                  <div className="endpoint-row">
                    <span className="endpoint-dot destination-dot" />
                    <RoomSearch
                      buildingId={DEMO_BUILDING_ID}
                      onSelect={chooseDestination}
                      label="DESTINATION"
                      selectedLabel={
                        destNode
                          ? destNode.roomNumber
                            ? `Room ${destNode.roomNumber}`
                            : destNode.name
                          : null
                      }
                      placeholder="Where’s your next class?"
                    />
                  </div>
                </div>
                <div className="location-actions">
                  <button onClick={handleLocate} disabled={locating}>
                    {locating ? (
                      <Loader2 className="animate-spin" size={14} />
                    ) : (
                      <LocateFixed size={14} />
                    )}
                    {locating ? 'Finding location…' : 'Use my location'}
                  </button>
                  {(pin || destNode) && (
                    <button
                      onClick={() => {
                        setSelectedStartId(null);
                        setPin(null);
                        setPinFloorId(null);
                        setDestNode(null);
                        setRoute(null);
                        setRouteError('');
                        setLocateMessage(null);
                        setGuiding(false);
                      }}
                    >
                      Reset <X size={12} />
                    </button>
                  )}
                </div>
                {locateMessage && (
                  <p className="inline-message" role="status">
                    {locateMessage}
                  </p>
                )}
                <div className="accessibility-row">
                  <span className="accessibility-icon">
                    <Accessibility size={19} />
                  </span>
                  <div>
                    <strong>Step-free route</strong>
                    <small>Elevators, no stairs</small>
                  </div>
                  <button
                    className={`toggle ${stepFree ? 'on' : ''}`}
                    role="switch"
                    aria-label="Step-free route"
                    aria-checked={stepFree}
                    onClick={() => {
                      setRoute(null);
                      setRouting(true);
                      setStepFree((value) => !value);
                    }}
                  >
                    <span />
                  </button>
                </div>
                <ArrivalCard
                  routeSeconds={
                    route?.found && !routing ? route.totalSeconds : null
                  }
                />
                {routeError && (
                  <p className="route-error" role="alert">
                    {routeError}
                  </p>
                )}
                {routing && (
                  <p className="inline-message" role="status">
                    <Loader2 className="animate-spin" size={15} /> Finding your
                    best route…
                  </p>
                )}
                {route && !routing ? (
                  <div className="route-content">
                    <RouteSteps
                      route={route}
                      activeFloorId={activeFloorId}
                      onFocusFloor={setActiveFloorId}
                    />
                    {route.found && (
                      <>
                        <button
                          className="primary-button directions-button"
                          onClick={() => {
                            setGuiding((value) => !value);
                            setGuideIndex(0);
                            setActiveFloorId(
                              route.legs[0]?.floorId || activeFloorId,
                            );
                          }}
                        >
                          {guiding ? <X size={17} /> : <Navigation size={17} />}
                          {guiding ? 'End directions' : 'Start directions'}
                          <ArrowRight size={17} />
                        </button>
                        {guiding && guideLeg && (
                          <div className="guidance-card" role="status">
                            <small>
                              FLOOR {guideIndex + 1} OF {route.legs.length}
                            </small>
                            <strong>{guideLeg.instruction}</strong>
                            <p>
                              You control your progress. Your position is not
                              tracked indoors.
                            </p>
                            <button
                              className="secondary-button"
                              onClick={() => {
                                if (guideIndex < route.legs.length - 1) {
                                  setGuideIndex(guideIndex + 1);
                                  setActiveFloorId(
                                    route.legs[guideIndex + 1].floorId,
                                  );
                                } else {
                                  setGuiding(false);
                                  setLocateMessage(
                                    'You’ve finished the directions. Check the room sign to confirm you’ve arrived.',
                                  );
                                }
                              }}
                            >
                              {guideIndex < route.legs.length - 1
                                ? 'Next floor'
                                : 'Finish directions'}{' '}
                              <Check size={15} />
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                ) : (
                  !routing && (
                    <div className="journey-empty">
                      <span>
                        <MapPin size={22} />
                      </span>
                      <h3>Your next stop starts here.</h3>
                      <p>
                        {destNode
                          ? 'Choose where you’re starting to see your route.'
                          : startNode
                            ? 'Choose a destination to see your route.'
                            : 'Add a starting point and destination to see your route and walking time.'}
                      </p>
                    </div>
                  )
                )}
                <div className="panel-footer">
                  <ShieldCheck size={14} />
                  <span>Routes follow mapped access points.</span>
                </div>
              </aside>
              <section
                className="map-panel"
                aria-label="Interactive building map"
              >
                <div className="map-toolbar">
                  <div>
                    <span className="map-status-dot" />
                    <strong>{building?.name}</strong>
                    <span className="map-toolbar-divider" />{' '}
                    <span>{activeFloor.name}</span>
                  </div>
                  <div
                    className="map-view-toggle"
                    role="group"
                    aria-label="Map view"
                  >
                    <button
                      aria-pressed={mapView === '2d'}
                      className={mapView === '2d' ? 'selected' : ''}
                      onClick={() => setMapView('2d')}
                    >
                      <Map size={14} />
                      2D
                    </button>
                    <button
                      aria-pressed={mapView === '3d'}
                      className={mapView === '3d' ? 'selected' : ''}
                      onClick={() => setMapView('3d')}
                    >
                      <Box size={14} />
                      3D
                    </button>
                  </div>
                </div>
                <div className="map-canvas">
                  {mapView === '3d' ? (
                    <Suspense
                      fallback={
                        <div className="model-loading">
                          <Loader2 className="animate-spin" size={24} />
                          <strong>Building your new perspective…</strong>
                          <span>Loading Grainger Hall in 3D.</span>
                        </div>
                      }
                    >
                      <Building3DMap
                        floors={floors}
                        nodes={nodes}
                        activeFloorId={activeFloor.id}
                        route={route}
                        guiding={guiding}
                        start={
                          pin && pinFloorId
                            ? {
                                floorId: pinFloorId,
                                point:
                                  startNode && accuracyMeters === null
                                    ? {
                                        x: startNode.imageX,
                                        y: startNode.imageY,
                                      }
                                    : pin,
                              }
                            : null
                        }
                        destination={destNode}
                        accuracyRadiusPx={accuracyRadiusPx}
                        onFocusFloor={setActiveFloorId}
                        onPlaceStart={(floorId, point) => {
                          setSelectedStartId(null);
                          setPin(point);
                          setPinFloorId(floorId);
                          setActiveFloorId(floorId);
                          setAccuracyMeters(null);
                          setLocateMessage(null);
                        }}
                        onDestinationSelect={chooseDestination}
                        onFallback={() => setMapView('2d')}
                      />
                    </Suspense>
                  ) : (
                    <FloorPlanMap
                      floor={activeFloor}
                      nodes={nodesOnActiveFloor}
                      routeLeg={activeLeg}
                      pin={
                        pinFloorId === activeFloor.id
                          ? startNode && accuracyMeters === null
                            ? { x: startNode.imageX, y: startNode.imageY }
                            : pin
                          : null
                      }
                      accuracyRadiusPx={accuracyRadiusPx}
                      destNodeId={destNode?.id ?? null}
                      authorMode={false}
                      onPinChange={handlePinChange}
                      onAuthorClick={() => {}}
                      onDestinationSelect={chooseDestination}
                    />
                  )}
                  <div className="floor-control">
                    <span>FLOOR</span>
                    {[...floors]
                      .sort((a, b) => b.level - a.level)
                      .map((floor) => (
                        <button
                          key={floor.id}
                          className={
                            activeFloorId === floor.id ? 'selected' : ''
                          }
                          aria-label={`Show ${floor.name}`}
                          aria-pressed={activeFloorId === floor.id}
                          onClick={() => setActiveFloorId(floor.id)}
                        >
                          {floor.level}
                          {route?.found &&
                            route.legs.some(
                              (leg) => leg.floorId === floor.id,
                            ) && <i />}
                        </button>
                      ))}
                  </div>
                  {mapView === '2d' && (
                    <>
                      <div className="map-instruction">
                        <span className="instruction-icon">
                          <LocateFixed size={17} />
                        </span>
                        <span>
                          <strong>
                            {pin
                              ? 'Make yourself at home.'
                              : 'Where are you right now?'}
                          </strong>
                          <small>
                            {pin
                              ? 'Routes use mapped access points. Tap a room to explore.'
                              : 'Select your floor, then tap the map to set your location.'}
                          </small>
                        </span>
                      </div>
                    </>
                  )}
                  {mapView === '2d' && (
                    <span className="map-compass">
                      N<Navigation size={21} fill="currentColor" />
                    </span>
                  )}
                </div>
                <div className="map-legend">
                  <div>
                    <span>
                      <i className="legend-you" /> You are here
                    </span>
                    <span>
                      <i className="legend-destination" /> Destination
                    </span>
                    <span>
                      <i className="legend-route" /> Your route
                    </span>
                  </div>
                  <span className="map-interaction-hint">
                    {mapView === '3d'
                      ? 'Drag to orbit · Pinch to zoom · Click a room'
                      : 'Scroll to zoom · Drag to explore'}
                  </span>
                </div>
              </section>
            </div>
            <section className="discover-section">
              <div className="discover-heading">
                <div>
                  <h2>
                    Around Grainger Hall <span>A good place to start</span>
                  </h2>
                </div>
                <button onClick={() => navigate('/directory')}>
                  View directory <ArrowUpRight size={15} />
                </button>
              </div>
              <div className="quick-places">
                {popular.map((node, index) => (
                  <button
                    key={node.id}
                    className="quick-place"
                    onClick={() => chooseDestination(node)}
                  >
                    <span className={`quick-place-icon place-tone-${index}`}>
                      {node.kind === 'entrance' ? (
                        <DoorOpen size={20} />
                      ) : node.kind === 'restroom' ? (
                        <Accessibility size={20} />
                      ) : (
                        <GraduationCap size={20} />
                      )}
                    </span>
                    <span>
                      <strong>{node.name}</strong>
                      <small>
                        {node.floor?.name}
                        {node.roomNumber
                          ? ` · Room ${node.roomNumber}`
                          : ` · ${node.kind}`}
                      </small>
                    </span>
                    <ChevronRight size={17} />
                  </button>
                ))}
              </div>
            </section>
            <footer className="page-footer">
              <span>
                <span className="small-green-dot" /> A clearer way through
                campus.
              </span>
              <span>
                {rooms.filter((node) => node.kind === 'room').length} rooms ·{' '}
                {floors.length} floors · One less thing to worry about
              </span>
              <span>Made for the moments between classes.</span>
            </footer>
          </>
        )
      )}
    </div>
  );
}
