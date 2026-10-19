# Workspace Summary

> This is the **work-to-date** summary of this workspace. It starts from the template's initial
> state below and **you (the agent) keep it updated** as you make meaningful changes (new/renamed
> types, new UI pages/routes, seed/data, key decisions). Read it first at the start of a chat to
> recall what has been done; update it as you go. Keep it concise — a map, not a transcript.

## Current state

**TardyAI** — indoor wayfinding ("Google Maps for inside buildings") for students who are late or
lost in large campus buildings. Demo building: **Grainger Hall**, UW-Madison business school.

**Two independent ways to get a route**, deliberately kept side by side rather than merged:

| Feature | Route comes from | Page |
| --- | --- | --- |
| **Navigate** | A* over a hand-authored `MapNode`/`NavEdge` graph (deterministic) | `/` and `/navigate` |
| **Room Finder** | A vision LLM reading annotated floor-plan images (plain-English ask) | `/room-finder` |

- **Backend (`src/`):** complete and smoke-tested. 19 `.c3typ` files + `NavRouter.js` (A* router)
  + `RoomFinder.py` (vision wayfinder).
- **Data (`data/`):** real Grainger Hall graph — 1 building, 3 floors, 75 nodes, 156 edges, 24 rooms
  — plus 75 `Waypoint`s, 3 `AnnotatedPlan`s and 1 `BuildingFacts`. Loaded via `upsertSeedData`; all
  5 router methods and all 4 Room Finder methods verified against it.
- **UI:** both pages are built and wired to the backend. `npm run build` (lint + tsc + bundle) green.
- **Floor plan images:** real UW-Madison Space Management plans in
  `ui/react/public/plans/floor_p1..p4.png`, all 1980×1530, plus model-facing annotated renders in
  `ui/react/public/plans/annotated/1..3.png` (1500×1159).

End-to-end demo routes that work today:

- **Navigate:** West Entrance (L1) → room **3335**, ~3 min, 2 legs. Toggling step-free swaps West
  Stairs for Elevator C — the accessibility story in one click.
- **Room Finder:** "I'm at the west entrance and I need to get to the Learning Commons" →
  `ENT-W → 1-W8 → 1-W2 → E1 → E1 → 3-W4 → 3210`, 2 floor segments, drawn as a polyline.

## Git

Pushed to `github.com/kushsarora/TardyAI`, branch **`main`** (the repo was empty before this).
Local branch is `steeb`, tracking `origin/main`. Two commits: a baseline of the 157 source files,
then the root `README.md`. `ui/content/` (Vite build output) is **not** tracked — the template's
`ui/.gitignore` ignores `content`, so a fresh clone needs
`cd pkgbc231600/ui/react && npm install && VITE_C3_PKG=pkgbc231600 npm run build`.

**Room Finder is being developed on `steeb` to be merged into the Navigate work by MR.** It is
therefore **additive-only**: new files are strongly preferred over edits to existing ones, and no
inverse collection field was added to `Building` or `Floor` (`Waypoint`/`AnnotatedPlan`/
`BuildingFacts` reference them one-way). Total edits to pre-existing files: 2 one-line additions to
`App.tsx`, 2 to `config/navigation.ts`, one appended block in `Interfaces.tsx`, and the
`.gitignore` fix below. Nothing in `pages/Navigate/`, `lib/tardyApi.ts` or `lib/geoTransform.ts`
was touched.

> **`.gitignore` bug, fixed — read this before trusting any older clone.** The generic *Python*
> section carries an unanchored `lib/` (meant for a setuptools build directory), which also matched
> `pkgbc231600/ui/react/src/lib/` and silently excluded **`utils.ts` (the `cn` helper every
> `components/ui/*` file imports), `tardyApi.ts` and `geoTransform.ts`**. A fresh clone could not
> type-check the frontend at all, so the build instructions above were broken as written. Fixed by
> appending `!pkgbc231600/ui/react/src/lib/` — a **folder**-level negation, because git cannot
> un-ignore a file whose parent directory is excluded. Verified with `git check-ignore -v`.

The template's unreferenced `ui/react/src/data/sampleData.ts` was deleted — no mock data files
remain anywhere in `ui/react/src/`.

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

### Room Finder (vision-LLM wayfinding)

8 new `.c3typ` files, all additive. Entity types (persisted):

- **`Waypoint`** — a labelled point a human placed in a corridor. `floor`, `label` (the short code
  the model reads off the plan, e.g. `3-W4`, `E1`, `ENT-W`), `kind`, `name`, `roomNumber`,
  `imageX/Y`, `connectorKey`, `aliases`. **The label is the contract with the model.**
- **`AnnotatedPlan`** — one per floor. `floor`, `imageUrl` (model-facing annotated render),
  `imageWidth/Height`, `labelsShown`.
- **`BuildingFacts`** — `building`, `facts` (~2.8 KB of prose the model is given verbatim),
  `demoRoutes` (the example questions the UI shows as chips).
- **`RouteQuery`** — one row per ask, for provenance and pinning. `isPinned` marks an answer as the
  pinned fallback for its question.

Value types: `RouteWaypoint`, `RouteFloorSegment`, `VisionRoute`.

**`RoomFinder`** (`@py(env='server')`, impl in `RoomFinder.py`, ~1080 lines) — 4 methods:

| Method | Returns | Notes |
| --- | --- | --- |
| `findRoute(buildingId, message, allowFallback)` | `VisionRoute` | The whole feature. One retry on validation failure, then the pinned fallback if `allowFallback`. |
| `syncPlanImages(buildingId, uiServiceBaseUrl)` | `int` | **One-time setup** — see gotchas. |
| `pinRoute(queryId, pinned)` | `boolean` | Pins a good answer as that question's fallback. |
| `diagnostics(buildingId)` | `json` | Readiness report; drives the UI's "not ready" banner. |

**How `findRoute` works, and why it is built this way:** the annotated plans + `BuildingFacts#facts`
go to the vision model as a cached prefix (user message last, so the images cache across asks). The
model answers with **waypoint labels only — never coordinates.** The server resolves each label
against the `Waypoint` table and builds the geometry itself, so every coordinate the UI draws came
out of the database. A hallucinated *label* fails validation and degrades to written steps; a
hallucinated *coordinate* would have drawn a confident line through a wall, which is exactly the
failure mode this design removes. The model may also answer `clarify` with a question instead of
guessing.

## UI pages / routes

| Route | Component | Notes |
| --- | --- | --- |
| `/` and `/navigate` | `pages/Navigate/Navigate.tsx` | Graph router. Owns all routing state. |
| `/room-finder` | `pages/RoomFinder/RoomFinder.tsx` | Vision wayfinder. One ask, one answer held. |

Nav: "Navigate" + "Room Finder" in `config/navigation.ts`. `TopNav` title is "TardyAI". The
template's `Dashboard` page was deleted.

**`main.tsx` uses `HashRouter`,** so app routes live *after* a `#`. The preview URL is
`http://localhost:9000/<env>/liveapp/uiservice/#/room-finder` — the path-based form silently falls
through to `/` and renders Navigate, which looks exactly like a missing route registration.

Supporting modules:

- **`components/FloorPlan/FloorPlanMap.tsx`** — pan/zoom viewport, plan `<img>` + SVG overlay,
  draggable pin, accuracy circle, route polyline, connector markers, author-mode click reporting.
  Markers are scaled by `1/zoom` so they stay a constant size on screen. **Zoom and pan are a
  single `ViewTransform` state** (`{ zoom, offset }`), because the legal range of `offset` is a
  function of `zoom` — see the pan-clamp decision below. The Room Finder's `FloorMap.tsx` has no
  pan/zoom at all (static fitted image), so viewport-bounds concerns apply only to this file.
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

Room Finder modules (all new files under `pages/RoomFinder/`):

- **`lib/roomFinderApi.ts`** — the 3 `c3Action` calls plus `normalizeRoute`, which forces every
  nested collection to an array and **downgrades `drawable` to false unless some segment really has
  ≥2 points** — so a malformed `ok` answer degrades to steps-only instead of rendering an empty SVG.
  `fetchBuildingFacts` deliberately omits the `facts` field (2.8 KB of model-facing prose the UI
  never shows).
- **`FloorMap.tsx`** — plan `<img>` + SVG overlay, `viewBox` in raster coordinates. White casing
  polyline under a blue one, hollow start circle, filled end disc (orange + dashed ring when the
  leg ends at a floor change). Latches image-load failure and resets the latch when the URL changes.
- **`FloorTabs.tsx`** — **tab identity is the segment index, not the floor key**, because a route
  can leave a floor and come back, producing two segments with the same key; keying by floor would
  collapse them and silently drop half the journey. A single-segment route renders plain text
  instead of a lone tab that looks broken.
- **`StepList.tsx`** — renders from `steps` alone so it survives a non-drawable route. A row is a
  real `<button>` only when its floor key is known, so no inert control promises an interaction it
  cannot deliver.
- **`ChatInput.tsx`** — textarea (not an input: the model does better with a sentence), Enter
  submits / Shift+Enter newlines, guards blank input because `message` is `!string` server-side.
  Example chips set the text *and* submit in one tap.

Deliberately **not** built: the 3D stacked-floor view. 2D is the functional core; see Key decisions.

## Seed / data

`data/` (plain `entity type`, no `SeedData` mixin), loaded with `upsertSeedData`:

- `data/Building/grainger.json` — id `grainger`, centroid 43.07258 / -89.40092
- `data/Floor/Floor.json` — `grainger-f1/f2/f3`, levels 1-3, 1980×1530, `pixelsPerMeter: 12.0`,
  2-point `calibration` (NW + SE building corners)
- `data/MapNode/MapNode.json` — 75 nodes: 35 hallway, 24 room, 9 elevator (3 shafts × 3 floors),
  3 stairs (1 shaft × 3 floors), 3 restroom, 1 entrance (`n-f1-entrance-w`)
- `data/NavEdge/NavEdge.json` — 156 directed same-floor edges
- `data/Waypoint/Waypoint.json` — 75 labelled waypoints (same points as `MapNode`, re-labelled for
  the model: `3-W4`, `E1`, `ENT-W`, room numbers)
- `data/AnnotatedPlan/AnnotatedPlan.json` — 3 records, one per floor, 1500×1159
- `data/BuildingFacts/facts-grainger.json` — 1 record, id `grainger`, with the 5 `demoRoutes`

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
- **Secrets:** root `.gitignore` covers `.env*` **at every directory level** (verified with
  `git check-ignore` on nested paths), `node_modules/`, `**/gen/cache/**`, `.vs-cache`,
  `*.c3pkg.lock.json`, `.claude/**` (with `!.claude/skills/`), `.attachments`, `.playwright`,
  `.playwright-mcp/`. Added `/*.png|jpg|jpeg|webp` so Playwright screenshots dropped in the repo
  root can never be committed (`ui/react/public/` is unaffected — the rules are root-anchored).
  Pattern-scanned the whole committed set for token/key/JWT shapes: zero hits.
  `VITE_C3_AUTH_TOKEN` appears in `vite.config.mts` / `package.json` / `ui/react/README.md` only as
  a *variable name*, never with a value.
- **2D is primary, 3D is a demo shot.** `three.js` / `@react-three/fiber` deliberately **not**
  installed yet; the overview can be extruded procedurally from the same graph JSON later.
- **Pan is clamped so the plan always covers the viewport.** Zoom was already floored at the
  fit-to-view scale, but the drag handler wrote `startOffset + delta` straight to state with no
  bound, so the plan could be slid completely off screen into an empty grey panel — with no way
  back except the fit button. `clampOffsetAxis` now bounds each axis: when the scaled plan exceeds
  the viewport the offset is held in `[viewportExtent - scaledExtent, 0]` (every part reachable,
  viewport always covered, no dead space); when it does not — which is both axes at fit zoom, since
  `FIT_MARGIN` leaves a border — it is centred, so a pan at fit zoom is a no-op instead of a slide
  into nothing. The clamp is applied on **both** drag and zoom, because zooming out around a corner
  shrinks the plan away from the opposite edge. Two details that are load-bearing: the pan handler
  **re-anchors `drag.startOffset` to the clamped result** (otherwise dragging into a stop banks up
  slack the user must drag back out before the map moves again), and `clampOffsetAxis` is
  **idempotent**, which is what makes that re-anchoring sound.

Room Finder:

- **The model returns labels, never coordinates.** This is the single load-bearing decision — see
  `findRoute` above. It converts the dangerous failure (a confident line through a wall) into a
  visible one (validation fails, written steps only).
- **⚠️ DEVIATION FROM THE SPEC: `temperature` is omitted, not set to 0.** The spec says "set
  temperature to 0"; the configured model rejects it outright —
  `litellm.UnsupportedParamsError: global.anthropic.claude-sonnet-5 does not support temperature=0`.
  Passing *any* explicit temperature fails, so the option is left out of `options` entirely and the
  model's default (1) applies. Determinism is recovered the way that actually works here: a tightly
  constrained label vocabulary, server-side validation, one retry, and pinned fallbacks for the
  demo questions. **Do not "fix" this by re-adding `temperature`.**
- **Two coordinate spaces, one `viewBox`.** Waypoints live in the original 1980×1530 raster (what
  the UI draws on); the annotated 1500×1159 render is model-facing only. Same aspect ratio, so one
  `viewBox` serves either image and the "show what the AI sees" toggle needs no re-projection.
- **Prompt caching puts the images + facts first and the user message last**, so the expensive
  prefix is reused across asks. `VisionRoute` reports `promptTokens`/`cachedTokens` and the UI shows
  the hit rate.
- **Provenance is a feature, not debug output.** The panel shows live-vs-pinned, whether the one
  permitted retry fired, latency, cache hit rate, and the accepted label chain. An audience is
  entitled to ask how an answer was produced without anyone opening a console.
- **A clarifying question is a success path.** `status: 'clarify'` renders as the model talking, not
  as an error, because it is what prevents a confidently wrong route.

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
- **The Room Finder data is generated, not hand-edited.** `tools/build_waypoints.py` derives
  `data/Waypoint/`, `data/AnnotatedPlan/`, `data/BuildingFacts/` **and** the annotated PNGs from the
  existing `data/MapNode` + `data/Floor` graph. Re-run it (`python3 tools/build_waypoints.py`) after
  changing nodes or floors rather than editing the waypoint JSON by hand, then `upsertSeedData` and
  `RoomFinder.syncPlanImages`. Because the labels are burned into the image, the annotated render
  only has to be *legible* — its resolution is irrelevant to correctness, which is why it is
  1500×1159 while the waypoints stay in the original 1980×1530 space.
- **Playwright cannot verify the API end-to-end here.** A headless browser on `localhost:9000` has
  no Genesis session cookie, so the Vite proxy forwards an unauthenticated request and the app 302s
  to the OIDC provider. The page chrome renders and the `c3Action` calls do fire (visible in the
  network log), but they fail auth. Verification therefore uses the documented fallback: replaying
  each exact FetchSpec / method call through `runJsCode`. The user's own preview iframe carries the
  cookie and works.
- **`RoomFinder.syncPlanImages` is a required one-time setup step** on a fresh environment. The
  server cannot read `ui/react/public/` directly, so the annotated PNGs have to be copied into the
  C3 filesystem before the model can be shown anything. Call it once per environment (it returns
  the number of images synced); `diagnostics(buildingId)` reports `readablePlanCount` and will say
  the building is not ready until it has run.
- **A single-record data file must be named after the record id.** `data/BuildingFacts/facts-grainger.json`
  holds the record whose `id` is `grainger`; a differently-named single-object file does not load.
  Multi-record files (`Waypoint.json`, `MapNode.json`) are named after the type and are fine.
- **The first call to a freshly-edited Python type times out.** The import/compile happens inside
  the request, so the first `runPyCode` after editing `src/RoomFinder.py` reliably exceeds the
  timeout. Just retry — the second call succeeds. This is not a code fault; do not start debugging
  the method body over it.
- **`runPyCode` turns the last line into a `return`.** End every snippet with a single-line
  expression. A multi-line trailing expression (or a trailing statement) yields a syntax error or
  silently returns nothing.
- **`ref` does not work on `components/ui/*`.** React is 18.3.1 and only `Spinner` uses
  `forwardRef`, so passing `ref` to the others type-checks but React drops it at runtime. Measure or
  focus via a wrapper element instead.
- **`npm run build` needs `VITE_C3_PKG` in an agent shell.** Lint and `tsc` pass without it, then
  the bundle step dies with `Error: VITE_C3_PKG is not set`. There is no `.env` file (the UI
  container supplies the variable); for a one-off validation run use
  `VITE_C3_PKG=pkgbc231600 npm run build`. **Do not create a `.env` file.**
