# Workspace Summary

> This is the **work-to-date** summary of this workspace. It starts from the template's initial
> state below and **you (the agent) keep it updated** as you make meaningful changes (new/renamed
> types, new UI pages/routes, seed/data, key decisions). Read it first at the start of a chat to
> recall what has been done; update it as you go. Keep it concise — a map, not a transcript.

## Current state

**TardyAI** — indoor wayfinding ("Google Maps for inside buildings") for students who are late or
lost in large campus buildings. Demo building: **Grainger Hall**, UW-Madison business school.

- **Backend (`src/`):** complete and smoke-tested. 11 `.c3typ` files + `NavRouter.js` (A* router).
- **Data (`data/`):** real Grainger Hall graph — 1 building, 3 floors, 75 nodes, 156 edges, 24 rooms.
  Loaded via `upsertSeedData`; all 5 router methods verified against it.
- **UI:** the **Navigate** page is built and wired to the backend — floor plan map with pan/zoom,
  draggable "I'm here" pin + GPS accuracy circle, floor selector, route polyline, room search,
  turn-by-turn list, the class-timer card, and an Author mode for reading off pixel coordinates.
  `npm run build` (lint + tsc + bundle) is green.
- **Floor plan images:** real UW-Madison Space Management plans in
  `ui/react/public/plans/floor_p1..p4.png`, all 1980×1530.

End-to-end demo route that works today: West Entrance (L1) → room **3335**, ~3 min, 2 legs.
Toggling step-free swaps West Stairs for Elevator C, which is the accessibility story in one click.

See `TEMPLATE_SUMMARY.md` for the template initial state (structure, the `c3Action` API, how to add
a route + nav item, which examples to copy).

## Packages

- `pkgbc231600` (main, name immutable) — depends on `mcpServer 8.10`.

## Backend types

Entity types (persisted):

- **`Building`** — `name`, `campus`, `address`, `defaultFloorLevel`, `centroidLat/Lon`, `floors`
- **`Floor`** — `building`, `level`, `name`, `planImageUrl`, `imageWidth/Height`, `pixelsPerMeter`,
  `calibration`, `nodes`. Defines the **pixel coordinate space** all geometry lives in.
- **`MapNode`** — graph vertex. `floor`, `kind`, `roomNumber`, `name`, `imageX/Y`, `connectorKey`,
  `stepFree`, `searchAliases`, `outgoingEdges`/`incomingEdges`
- **`NavEdge`** — directed, same-floor only. `fromNode`, `toNode`, `edgeType`, `seconds`, `meters`,
  `stepFree`

Value types (not persisted): `GeoCalibration`, `CalibrationPoint`, `RoutePoint`, `RouteLeg`,
`NavRoute`, `NavGraphSnapshot`.

**`NavRouter`** (`@js(env='server')`, impl in `NavRouter.js`) — 5 methods. The method declarations
carry **no** per-method language claim; the type-level `@js(env='server')` annotation is sufficient
and is the form that currently validates clean and dispatches correctly (all 5 verified by call).

| Method | Returns | Verified behavior |
| --- | --- | --- |
| `findRoute(startNodeId, destNodeId, stepFree)` | `NavRoute` | 1 leg single-floor, 2 legs multi-floor; all failure paths return `found:false` |
| `routeToRoom(buildingId, startNodeId, roomQuery, stepFree)` | `NavRoute` | agrees with `findRoute`; resolves "3112" and "Keller" |
| `nearestNode(floorId, imageX, imageY)` | `MapNode` | snaps pin; `null` for unknown floor |
| `searchRooms(buildingId, query, limit)` | `[MapNode]` | ranked; `limit` null → 10, capped at 50 |
| `graphForBuilding(buildingId)` | `NavGraphSnapshot` | 75 nodes / 156 edges |

## UI pages / routes

| Route | Component | Notes |
| --- | --- | --- |
| `/` and `/navigate` | `pages/Navigate/Navigate.tsx` | The whole app. Owns all routing state. |

Nav: single "Navigate" item in `config/navigation.ts`. `TopNav` title is "TardyAI". The template's
`Dashboard` page was deleted.

Supporting modules:

- **`components/FloorPlan/FloorPlanMap.tsx`** — pan/zoom viewport, plan `<img>` + SVG overlay,
  draggable pin, accuracy circle, route polyline, connector markers, author-mode click reporting.
  Markers are scaled by `1/zoom` so they stay a constant size on screen.
- **`pages/Navigate/RoomSearch.tsx`** — debounced (220 ms) search against `NavRouter.searchRooms`.
- **`pages/Navigate/RouteSteps.tsx`** — one row per floor; clicking a row switches the map floor.
- **`pages/Navigate/ArrivalCard.tsx`** — the TardyAI hook. Compares `now + route duration` against
  the class start time; recomputes every 15 s so the verdict cannot silently go stale.
- **`lib/tardyApi.ts`** — all `c3Action` calls and the FetchSpecs, in one place. Also
  `resolvePlanUrl`, which joins `Floor#planImageUrl` onto `import.meta.env.BASE_URL` (the app is
  served from `/<env>/<app>/uiservice/`, so a root-relative `/plans/...` would 404).
- **`lib/geoTransform.ts`** — client-side lat/lon → pixel fit: least-squares affine for 3+ control
  points, closed-form similarity for exactly 2, null below that. Falls back to similarity if the
  affine normal equations come out singular (collinear points).

Deliberately **not** built: the 3D stacked-floor view. 2D is the functional core; see Key decisions.

## Seed / data

`data/` (plain `entity type`, no `SeedData` mixin), loaded with `upsertSeedData`:

- `data/Building/grainger.json` — id `grainger`, centroid 43.07258 / -89.40092
- `data/Floor/Floor.json` — `grainger-f1/f2/f3`, levels 1-3, 1980×1530, `pixelsPerMeter: 12.0`,
  2-point `calibration` (NW + SE building corners)
- `data/MapNode/MapNode.json` — 75 nodes: 35 hallway, 24 room, 9 elevator (3 shafts × 3 floors),
  3 stairs (1 shaft × 3 floors), 3 restroom, 1 entrance (`n-f1-entrance-w`)
- `data/NavEdge/NavEdge.json` — 156 directed same-floor edges

Room numbers are **real** — spot-checked against `floor_p1.png` and `floor_p3.png` (1100 Morgridge
Auditorium, 1210 Huber Lab, 3111 Conf. Room, 3210 Learning Commons, 3335 Class Room, 3560 Seminar
Room all appear on the actual plans).

Node id convention: `n-f<level>-<slug>` (e.g. `n-f3-r3112`, `n-f1-stair-w`).

## Key decisions

- **Pixel space is authoritative**, not lat/lon. Node geometry is stored as `imageX/imageY` against
  the floor plan raster. Lat/lon enters only via `Floor.calibration` to *suggest* a starting pin.
- **Floor is chosen manually, never sensed.** Browser `navigator.geolocation` gives 5-15 m
  horizontal and 15-40 m *vertical* error against ~4 m floor spacing, and there is no shipping Web
  barometer API — so altitude cannot determine a floor. The UI must use a floor selector with smart
  defaults, auto-advancing as a route crosses floors.
- **Cross-floor movement is synthesized, not stored.** No `NavEdge` ever spans floors. `MapNode`s
  sharing a `connectorKey` are implicitly linked and the cost is computed from the level delta.
  Keeps seed data authorable by hand and makes adding a floor a local change.
- **Edge cost is time (seconds), not distance.** `pixelsPerMeter` therefore affects *only* the A*
  heuristic, never the returned route.
- **`ELEVATOR_WAIT_SECONDS = 40`** (not 25). At 25 s a two-floor climb scored 45 s by elevator vs
  44 s by stairs — a 1-second tie decided by rounding-level walking differences. At 40 s stairs win
  decisively for 1-3 floors (realistic for a hurried student), and the step-free toggle changes the
  route *and* the ETA on **all 17** tested multi-floor routes. Tunable in `NavRouter.js`.
- **A* heuristic stays admissible** via `HEURISTIC_SAFETY = 0.9` and by using
  `ELEVATOR_PER_FLOOR_SECONDS` (10, the cheapest vertical rate, wait excluded) for the cross-floor
  term. Elevator *wait* is deliberately excluded from the heuristic.
- **Routing failure is a value, not an exception** — `NavRoute.found:false` + a user-facing
  `message`. But note the second channel below.
- **`!string` params are enforced by the platform before the method body runs.** null, `""` and
  whitespace-only all raise `Err.InvalidCall` — a *rejected promise*, not a `found:false` route. The
  UI must guard: never call `searchRooms` on an empty box or `findRoute` without a start pin.
- **`.objs` supports native `arr[i]` and `.length` in Rhino** — verified by running the router.
  `.each()` / `.get(i)` are still preferred style, but the existing indexing is not a bug.
- **Secrets:** root `.gitignore` already covers `.env*`, `node_modules/`, `**/gen/cache/**`,
  `.vs-cache`, `*.c3pkg.lock.json`, `.claude/**` (with `!.claude/skills/`). Verified no secrets
  among the untracked files. No change needed.
- **2D is primary, 3D is a demo shot.** `three.js` / `@react-three/fiber` deliberately **not**
  installed yet; the overview can be extruded procedurally from the same graph JSON later.

## Open items / gotchas

- **`floor_p4.png` is unmapped.** Four plan images exist but only three `Floor` records. Room
  numbering suggests a Level 4 (unverified — the 2nd digit encodes *wing*, not floor, so this needs
  a look at the image). Add a `Floor` + nodes if the demo needs it.
- **Room 3112 is a small office**, not a lecture hall, per the real plan. For an "I'm late to class"
  demo, `3210` (Learning Commons), `3335` or `3339` (Class Room) read better as destinations.
- **Clear caches after editing `src/`.** The live app serves stale type metadata and stale JS
  implementations; `clearCaches` (workspace id `14a0c529-8f4e-41d4-b1d9-8056da8ba41a`) is required
  before a `runJsCode` smoke test will reflect an edit. A stale type caused a spurious
  "Type Floor does not declare field: pixelsPerMeter" on `upsertSeedData`.
- **The platform rewrites method language claims in `NavRouter.c3typ`.** It has appended ` js server`
  and ` js` to the 5 method declarations unprompted. Both forms are **parse errors**: `js server`
  reads as return type `X js` plus a stray `server` member, and a bare trailing `js` leaves the
  parser expecting more. The working form is **no trailing claim at all** plus the type-level
  `@js(env='server')`. If routing suddenly breaks, `grep -n "function(" src/NavRouter.c3typ` and
  strip anything after the return type.
- **Clearing caches is required after editing `NavRouter.js`.** A stale implementation cache made
  `stepFree: true` and `false` return byte-identical routes, which looks exactly like a logic bug in
  the accessibility mode. `clearCaches` fixed it with no code change.
- **Vision-model floor-plan extraction stub** lives in `tools/build_graph.py`
  (`extract_nodes_from_plan`), with the intended 6-step OCR + skeletonization pipeline documented.
  It raises `NotImplementedError` by design.
- **Playwright cannot verify the API end-to-end here.** A headless browser on `localhost:9000` has
  no Genesis session cookie, so the Vite proxy forwards an unauthenticated request and the app 302s
  to the OIDC provider. The page chrome renders and the `c3Action` calls do fire (visible in the
  network log), but they fail auth. Verification therefore uses the documented fallback: replaying
  each exact FetchSpec / method call through `runJsCode`. The user's own preview iframe carries the
  cookie and works.
