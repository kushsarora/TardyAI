# TardyAI

Indoor wayfinding — "Google Maps for inside buildings." Built for students who are late or lost in
large, confusing campus buildings. Demo building: **Grainger Hall**, UW–Madison business school.

Type a room number, get a walking route drawn on the real floor plan, across floors, with an honest
answer to the only question that matters: *am I going to be late?*

## What it does

- **Floor plan map** — real UW–Madison Space Management plans, pan/zoom, floor selector.
- **"I'm here" pin** — tap the plan, or let the browser suggest a position from GPS. The GPS
  accuracy circle is drawn so the uncertainty is visible, and the pin stays draggable.
- **Room search** — by number (`3335`) or name (`Learning Commons`).
- **A\* routing** — over a graph of rooms, hallway intersections, doors, stairs and elevators.
  Edge cost is **time**, not distance.
- **Multi-floor routes** — "Take the elevator to Level 3", with one leg per floor.
- **Step-free mode** — blocks stair edges and prefers elevators. One toggle, different route *and*
  different ETA.
- **The TardyAI hook** — enter your class start time, get "Arrive 2 min late" or "You have 3 min to
  spare", recomputed every 15 s.

## Architecture

The app supports both a **connected C3 AI environment** and a **standalone building demo**.
Connected mode fetches domain data over `c3Action`. Demo mode packages the existing JSON seed data
and the **same `NavRouter.js` implementation** through a Vite virtual module; there is no second routing algorithm.
The header identifies demo mode. There is no silent fallback from a failed live API to demo data.

```
pkgbc231600/                  # the C3 package (name is fixed — do not rename)
  src/                        # C3 types (.c3typ) + NavRouter.js (the A* router, server-side JS)
  data/                       # the Grainger Hall graph: 1 building, 3 floors, 674 nodes (261 rooms), 1356 edges
  ui/react/                   # Vite + React 18 + TypeScript + Tailwind frontend
    public/plans/             # rasterized floor plans (1980×1530)
tools/                        # offline helpers (PDF → PNG, graph authoring)
```

### Backend types

| Type | Role |
| --- | --- |
| `Building` | the building, its centroid, its floors |
| `Floor` | the **pixel coordinate space** all geometry lives in (plan image + scale + GPS calibration) |
| `MapNode` | a graph vertex: room, hallway, door, stairs, elevator, entrance, restroom |
| `NavEdge` | a directed, **same-floor** walkable connection, costed in seconds |
| `NavRouter` | 5 methods: `findRoute`, `routeToRoom`, `nearestNode`, `searchRooms`, `graphForBuilding` |

Two decisions worth knowing before you change anything:

- **Pixel space is authoritative, not lat/lon.** Node positions are `imageX`/`imageY` against the
  floor plan raster. Lat/lon enters only via `Floor.calibration`, and only to *suggest* a pin.
- **Cross-floor movement is synthesized, never stored.** No `NavEdge` spans floors. `MapNode`s that
  share a `connectorKey` (the same stairwell or elevator shaft) are implicitly linked, and the cost
  is derived from the level difference. Adding a floor stays a local change.

### Why you pick your own floor

GPS gives roughly 5–15 m horizontally indoors and 15–40 m *vertically*, against about 4 m of floor
spacing — so altitude cannot tell storeys apart. No browser ships a barometer API either. So the app
never guesses the floor: you tap it. The floor selector auto-advances as a route crosses floors.

## Running it

For a standalone local demo (no credentials required):

```bash
cd pkgbc231600/ui/react
npm ci
npm run dev
```

Open `http://localhost:9000`. To type-check, lint and bundle:

```bash
cd pkgbc231600/ui/react
npm ci
npm run build
```

The default is demo mode when `VITE_C3_ENV` is absent. Set `VITE_DATA_MODE=live` to force live mode,
or `VITE_DATA_MODE=demo` to force the standalone demo. For live C3 development, configure
`VITE_C3_PKG`, `VITE_C3_BASE_URL`, `VITE_C3_ENV`, and `VITE_C3_APP` through your environment;
C3 Code manages the dev server and deployment sync. Authentication remains in C3 settings.
A deployed live bundle must be built with the live environment variables; do not deploy a demo build as a live client.

The standalone demo includes only the graph-based navigation flow. The legacy `/room-finder`
vision assistant requires its C3 backend and model configuration.

`npm run build` runs ESLint at error level, then `tsc`, then Vite. All three must pass.

Room Finder's server logic (`src/RoomFinder.py`: the model reads the sentence, `NavRouter` picks the
path) is tested offline against the real router and seed data. Needs `python3` and `node`:

```bash
python3 -I -m unittest discover -s pkgbc231600/test/py -t pkgbc231600/test/py
```

## Secrets

Nothing secret is committed, and nothing secret needs to be. Specifically:

- `.env` files are ignored at **every** directory level, in every form (`.env`, `.env.local`,
  `.env.*.local`, `*.env`) — verified with `git check-ignore`.
- `VITE_C3_AUTH_TOKEN` appears in `vite.config.mts` only as a *variable name* — the dev proxy reads
  it from the environment at request time. It is never written to a tracked file.
- `node_modules/`, `.vs-cache/`, `**/gen/cache/**`, `ui/content/` (build output) and
  `*.c3pkg.lock.json` are ignored.
- Agent/editor session artifacts (`.claude/`, `.attachments/`, `.playwright/`, `.playwright-mcp/`)
  are ignored, as are browser screenshots dropped in the repo root.

Credentials are configured through the C3 Code **Settings** page, never in this repo.

## Known-approximate

Being explicit so nobody trusts these further than they deserve:

- **Node pixel coordinates were eyeballed** off the plan renders. They are the most likely visible
  flaw. Correct node positions in `tools/build_graph.py`, regenerate the seed graph, and rebuild.
  The student interface keeps coordinate-authoring tools out of the navigation flow.
- `pixelsPerMeter = 12.0` is an estimate. It affects only the A\* heuristic, never the returned
  route or its ETA.
- The two GPS calibration points are approximate building corners.
- `floor_p4.png` is rendered but unmapped — there are four plan images and three `Floor` records.
- Floor-plan extraction is **not** automated. `tools/build_graph.py` has a clearly marked
  `extract_nodes_from_plan()` stub documenting the intended vision pipeline; it raises
  `NotImplementedError` by design.

## Updated navigation experience

- Responsive green and ivory interface with a compact desktop rail and mobile bottom navigation.
- Choose a start by room/entrance search or by placing a draggable map pin. GPS is a suggestion,
  never a floor detector. Search a destination or select a labeled room on the floor plan.
- Keyboard suggestions (arrows, Enter, Escape), empty/error states, and stale-response protection.
- Searchable directory of mapped rooms, restrooms, and entrances; saved rooms persist in local storage.
- Swap endpoints, reset a journey, toggle step-free routing, and inspect each floor’s directions.
- Start directions for a user-controlled floor-by-floor walkthrough. This does **not** track your
  real indoor position. Finishing directions is a manual action, not proof of physical arrival.
- Today’s class time gives an arrival estimate, updates every 15 seconds, and conservatively rounds lateness.
- Wheel and pinch zoom, pan, fit-to-view, and keyboard map controls (`+`, `-`, arrows, `0`).
- Visible load/search/route errors, retry, image-failure notice, and application error recovery.

## Validation

```bash
node --test pkgbc231600/test/node/*.test.js
cd pkgbc231600/ui/react
npm test -- --runInBand --coverage=false
npm run build
```

The backend tests cover routing every mapped room from the entrance in default and step-free modes,
room/door integrity, cross-floor connectors, turn directions, and disconnected graph handling.
Frontend regressions cover room search races and keyboard selection, request failures, time-sensitive
arrival verdicts, and route step rendering. Browser checks additionally cover the full entrance-to-3335
journey, elevator routing, manual floor guidance, persistent favorites, zoom and pin interactions,
and desktop/mobile layouts.

## What still needs real-world work

The application is a functional wayfinding demo, not a surveyed indoor positioning system. Before
campus-wide use, verify corridor geometry and accessible entrances on site, calibrate plan scales,
map the fourth floor and additional buildings, and account for locked doors, construction, and
opening hours. Current route times use authored walking costs and fixed elevator estimates; they
do not incorporate live crowds or outages. Indoor GPS uncertainty is displayed, and selecting a floor
is always the user’s responsibility. Saved rooms are local to the browser, not synced to an account.

## Routing geometry revision: grainger-access-v2

Routes now start/end at mapped access points. `MapNode.imageX/imageY` are walkable
routing positions; `labelX/labelY` preserve the printed room label for map markers.
The zero-length room/door membership edge adds a 3-second door allowance without
inventing a walk across a classroom. A mapped access point is an approximate approach
on the circulation network, not a surveyed doorway or a measured indoor location.

The revised graph includes the Huber/Learning Commons internal circulation, its stairs
and elevator, and rooms 3210B–3210H. Upper-floor suite access does not cross the solid
south wall. The enclosed West Stairs now uses the south-west stairwell; the level-3
hatched central opening is no longer treated as a stair landing. The public east-wing
route may consequently choose an elevator even with step-free mode off.

`test/node/geometry.test.js` samples every graph edge against independently transcribed
interior rectangles for the reported classrooms, service blocks, and central openings.
It checks both screenshot journeys in both directions, in regular and step-free modes.
These obstacle fixtures cover specific problem areas; they do not certify every wall,
entrance, lift, or access restriction in the real building. Plan-derived circulation and
connector access still need an on-site check before production wayfinding.

**Updating an existing C3 environment:** deploy the updated `MapNode`, `NavEdge`,
`NavGraphSnapshot`, and `NavRoute` types and `NavRouter.js`, then upsert the regenerated
MapNode/NavEdge seeds. Reload the generated Waypoint, AnnotatedPlan, and BuildingFacts
data and annotated images if using the vision room finder. Deploy/rebuild the frontend
as well. C3 upserts retain removed records, so routing filters nodes and edges to
`routingRevision = grainger-access-v2`; obsolete shortcut records cannot rejoin the
current graph. The frontend rejects an older graph/service instead of drawing it.
The standalone demo packages the revised graph automatically at build time.
