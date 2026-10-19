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

This is a **C3 AI application**, not a standalone web app. All domain data lives in C3 entity types
and is fetched over `c3Action`; there is no hardcoded data in the frontend.

```
pkgbc231600/                  # the C3 package (name is fixed — do not rename)
  src/                        # C3 types (.c3typ) + NavRouter.js (the A* router, server-side JS)
  data/                       # the Grainger Hall graph: 1 building, 3 floors, 626 nodes (254 rooms), 1260 edges
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

The frontend dev server and the sync to the C3 environment are managed for you by C3 Code. To
type-check, lint and bundle:

```bash
cd pkgbc231600/ui/react
npm install
VITE_C3_PKG=pkgbc231600 npm run build
```

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
  flaw. Turn on **Author mode** in the UI, click a point on the plan, and paste the coordinate it
  reports into `tools/build_graph.py`.
- `pixelsPerMeter = 12.0` is an estimate. It affects only the A\* heuristic, never the returned
  route or its ETA.
- The two GPS calibration points are approximate building corners.
- `floor_p4.png` is rendered but unmapped — there are four plan images and three `Floor` records.
- Floor-plan extraction is **not** automated. `tools/build_graph.py` has a clearly marked
  `extract_nodes_from_plan()` stub documenting the intended vision pipeline; it raises
  `NotImplementedError` by design.
