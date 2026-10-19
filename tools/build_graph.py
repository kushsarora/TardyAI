#!/usr/bin/env python3
"""
TardyAI navigation-graph generator.

Turns the hand-authored corridor plan in `tools/grainger_corridors.py` into the
C3 `data/` JSON files for Grainger Hall. Edge costs (meters and seconds) are
COMPUTED from pixel geometry, so they can never drift out of sync with node
positions, and room access points are projected onto the authored circulation. Door hints
select the appropriate approach when a room is inside a suite or across a wall.

Usage:
    python3 tools/build_graph.py

Then regenerate the Room Finder data (`python3 tools/build_waypoints.py`, needs
Pillow) and load both into the app with the `upsertSeedData` MCP tool.

----------------------------------------------------------------------------
THE GRAPH THIS PRODUCES
----------------------------------------------------------------------------
Per floor:

- Corridor nodes (`hallway`, plus the stair/elevator/entrance nodes that sit on
  a corridor) linked in the order `grainger_corridors` lists them. Corridors
  are drawn along the open floor of the plan, so every corridor edge stays on
  open floor. Independent obstacle regressions cover the reported problem areas
  in test/node/geometry.test.js; this is not an automated survey of every wall.
- One `door` node per room, on the corridor segment nearest the room (or
  nearest the room's door hint), splitting that segment in two.
- One `room` (or `restroom`) node per room at its mapped access point, linked
  ONLY to its own door by a zero-length membership edge with a 3 s door allowance.
  labelX/labelY preserve the printed room position without making it walkable.

Cross-floor links are not edges: NavRouter synthesises them from connectorKey.

----------------------------------------------------------------------------
HOW TO FIX A NODE POSITION
----------------------------------------------------------------------------
Coordinates were read off the rendered floor plans (1980x1530) with a pixel
grid overlay. To move a corridor, edit its points in grainger_corridors.py; the
doors follow automatically. To move a room's door, give the room a door hint.
Re-run this script, then build_waypoints.py, then upsertSeedData.

----------------------------------------------------------------------------
STUB: AUTOMATED FLOOR PLAN EXTRACTION
----------------------------------------------------------------------------
`extract_nodes_from_plan()` below is the seam where a vision pipeline would
replace the hand-authored tables. The intended shape:

    1. Rasterize the floor plan page (already done -- see tools/render_plans.py).
    2. OCR room-number labels -> text + bounding box centroid. The Grainger PDF
       has its text converted to vector outlines, so a text layer does NOT exist
       and OCR is genuinely required; do not expect pdftotext to work.
    3. Detect corridor centerlines (morphological skeletonization of the
       white/unfilled space, or a learned segmentation model).
    4. Hand the centroids and centerlines to build_floor(), which already
       snaps each room to its corridor and inserts the door.
    5. Detect elevator/stair glyphs (the blue "X" boxes and stair hatching are
       consistent across UW facilities drawings) -> connector nodes, keyed by
       clustering their x/y across floors so the same shaft gets one
       connectorKey.
"""

from __future__ import annotations

import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from grainger_corridors import FLOOR_PLANS, FloorPlan, Point, RoomRow  # noqa: E402

# --------------------------------------------------------------------------
# Building constants
# --------------------------------------------------------------------------

BUILDING_ID = "grainger"
ROUTING_REVISION = "grainger-access-v2"
PKG_DATA = os.path.join(os.path.dirname(__file__), "..", "pkgbc231600", "data")

# Rendered plan dimensions (tools/render_plans.py, scale=2.5).
IMAGE_W, IMAGE_H = 1980, 1530

# Approximate image scale. Grainger Hall's footprint spans ~1850 px on these
# plans; at an estimated ~154 m across that is ~12 px/m. VERIFY THIS by
# measuring a corridor of known length -- it scales every time estimate in the
# app linearly.
PIXELS_PER_METER = 12.0

WALK_SPEED_MPS = 1.3
DOOR_PENALTY_SECONDS = 3.0

# Doors never sit closer than this to a corridor node or to another door on
# the same segment, so no edge is so short that its rounded cost is 0 s.
DOOR_MIN_GAP_PX = 4.0

FLOORS = [
    (1, "Level 1", "floor_p1.png"),
    (2, "Level 2", "floor_p2.png"),
    (3, "Level 3", "floor_p3.png"),
]

# Two control points at opposite corners of the building. Opposite corners are
# used deliberately -- closely spaced control points amplify fitting error.
# These lat/lon values are approximate for 975 University Ave and MUST be
# refined against satellite imagery before the GPS suggestion is trustworthy.
CALIBRATION = [
    {"label": "NW outside corner of building", "lat": 43.07305, "lon": -89.40205,
     "imageX": 95.0, "imageY": 40.0},
    {"label": "SE outside corner of building", "lat": 43.07210, "lon": -89.39980,
     "imageX": 1700.0, "imageY": 1460.0},
]

# Corridor points with these local ids are vertical connectors; every other
# corridor point is a hallway node unless it is an entrance below.
# local_id -> (kind, connectorKey, name)
CONNECTORS = {
    "elev-wa": ("elevator", "elev-west-a", "Elevator A (west)"),
    "elev-wb": ("elevator", "elev-west-b", "Elevator B (west)"),
    "elev-e": ("elevator", "elev-east", "Elevator C (east)"),
    "elev-commons": ("elevator", "elev-commons", "Learning Commons Elevator"),
    "stair-commons": ("stairs", "stair-commons", "Learning Commons Stairs"),
    "stair-w": ("stairs", "stair-west", "West Stairs"),
}

# local_id -> (name, searchAliases)
ENTRANCES = {
    "entrance-w": ("West Entrance", "door,entry,outside"),
}

RESTROOM_NAME = "Restrooms"
RESTROOM_ALIASES = "bathroom,washroom,toilet"

# A segment = (index into the corridor-edge list, endpoint a, endpoint b).
Segment = tuple[int, Point, Point]


def extract_nodes_from_plan(image_path, floor_level):
    """STUB -- automated floor plan extraction. See module docstring."""
    raise NotImplementedError(
        "Vision-based plan extraction is not implemented. "
        "Corridors and rooms are hand-authored in tools/grainger_corridors.py."
    )


def node_id(level: int, local_id: str) -> str:
    return "n-f%d-%s" % (level, local_id)


def floor_id(level: int) -> str:
    return "%s-f%d" % (BUILDING_ID, level)


def room_local_id(number: str) -> str:
    return "r%s" % number


def door_local_id(number: str) -> str:
    return "d%s" % number


def _project(px: float, py: float, a: Point, b: Point) -> tuple[float, float, float]:
    """Nearest point to (px, py) on segment a-b, as (t along the segment in px, x, y)."""
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = math.hypot(dx, dy)
    t = ((px - a[0]) * dx + (py - a[1]) * dy) / length
    t = min(max(t, 0.0), length)
    return t, a[0] + dx * t / length, a[1] + dy * t / length


def project_to_corridor(px: float, py: float, segments: list[Segment]) -> tuple[float, float, int]:
    """Nearest point to (px, py) on any of `segments`: (x, y, segment index).

    Ties go to the segment listed first, so the result is deterministic.
    Raises ValueError if `segments` is empty.
    """
    if not segments:
        raise ValueError("no corridor segment to put a door on")
    best = None
    for index, a, b in segments:
        _, x, y = _project(px, py, a, b)
        d = math.hypot(px - x, py - y)
        if best is None or d < best[0] - 1e-9:
            best = (d, x, y, index)
    return best[1], best[2], best[3]


def _spread_doors(ts: list[float], length: float, what: str) -> list[float]:
    """Move door positions (sorted, px along a segment) apart by DOOR_MIN_GAP_PX.

    Keeps every door at least the gap from both segment ends and from its
    neighbours, moving each as little as a forward-then-backward sweep allows.
    Raises ValueError (naming `what`) when the segment is too short to hold them.
    """
    gap = DOOR_MIN_GAP_PX
    if length < gap * (len(ts) + 1):
        raise ValueError("%s: %.0f px is too short for %d doors" % (what, length, len(ts)))
    out = []
    for t in ts:
        out.append(max(t, gap, out[-1] + gap if out else gap))
    for i in range(len(out) - 1, -1, -1):
        limit = length - gap if i == len(out) - 1 else out[i + 1] - gap
        out[i] = min(out[i], limit)
    return out


def _edge_rows(level: int, a: str, b: str, coords: dict[str, Point], edge_type: str) -> list[dict]:
    """Both directed NavEdge rows for the undirected link a-b."""
    ax, ay = coords[a]
    bx, by = coords[b]
    meters = math.hypot(ax - bx, ay - by) / PIXELS_PER_METER
    seconds = meters / WALK_SPEED_MPS + (DOOR_PENALTY_SECONDS if edge_type == "door" else 0.0)
    return [{
        "id": "e-f%d-%s-%s" % (level, src, dst),
        "fromNode": {"id": node_id(level, src)},
        "toNode": {"id": node_id(level, dst)},
        "routingRevision": ROUTING_REVISION,
        "edgeType": edge_type,
        "seconds": round(seconds, 1),
        "meters": round(meters, 1),
        "stepFree": edge_type != "stair",
    } for src, dst in ((a, b), (b, a))]


def _node_row(level: int, local_id: str, xy: Point, kind: str, **extra) -> dict:
    row = {
        "id": node_id(level, local_id),
        "floor": {"id": floor_id(level)},
        "routingRevision": ROUTING_REVISION,
        "kind": kind,
        "imageX": float(round(xy[0], 1)),
        "imageY": float(round(xy[1], 1)),
        "stepFree": True,
    }
    row.update({k: v for k, v in extra.items() if v is not None})
    return row


def _corridor_node(level: int, local_id: str, xy: Point) -> dict:
    if local_id in CONNECTORS:
        kind, key, name = CONNECTORS[local_id]
        return _node_row(level, local_id, xy, kind, connectorKey=key, name=name,
                         stepFree=kind != "stairs")
    if local_id in ENTRANCES:
        name, aliases = ENTRANCES[local_id]
        return _node_row(level, local_id, xy, "entrance", name=name, searchAliases=aliases)
    return _node_row(level, local_id, xy, "hallway")


def build_floor(level: int, plan: FloorPlan) -> tuple[list[dict], list[dict]]:
    """MapNode and NavEdge rows for one floor. Pure: no I/O.

    Raises ValueError, naming the offender, when the plan is inconsistent:
    a corridor names an unknown point, a point is on no corridor, a link is
    listed twice, a room number repeats, or a corridor segment is too short
    for the access points that land on it. Nothing is returned on failure.
    """
    where = "floor %d" % level
    coords: dict[str, Point] = dict(plan.points)
    links: list[tuple[str, str]] = []
    seen_links: set[frozenset] = set()
    for chain in plan.corridors:
        ids = chain.split()
        if len(ids) < 2:
            raise ValueError("%s: corridor %r needs at least two points" % (where, chain))
        for a, b in zip(ids, ids[1:]):
            for p in (a, b):
                if p not in coords:
                    raise ValueError("%s: corridor point %r is not in points" % (where, p))
            key = frozenset((a, b))
            if a == b or key in seen_links:
                raise ValueError("%s: link %s-%s is listed twice or loops" % (where, a, b))
            seen_links.add(key)
            links.append((a, b))
    unused = set(coords) - {p for link in links for p in link}
    if unused:
        raise ValueError("%s: points on no corridor: %s" % (where, sorted(unused)))

    # Doors go on walkable segments only: never on a stair spur, or the room
    # behind it would be unreachable step-free.
    def door_ok(a: str, b: str) -> bool:
        return not any(CONNECTORS.get(p, ("",))[0] == "stairs" for p in (a, b))

    segments = [(i, coords[a], coords[b]) for i, (a, b) in enumerate(links) if door_ok(a, b)]

    # Assign every room (and the restroom) to a spot on its nearest segment.
    targets: list[tuple[str, str, RoomRow]] = [
        (room_local_id(r.number), door_local_id(r.number), r) for r in plan.rooms
    ]
    if plan.restroom is not None:
        wc = "wc%d" % level
        targets.append((wc, "d-" + wc, plan.restroom))
    numbers = [r.number for r in plan.rooms]
    dupes = sorted({n for n in numbers if numbers.count(n) > 1})
    if dupes:
        raise ValueError("%s: room numbers listed twice: %s" % (where, dupes))

    on_segment: dict[int, list[tuple[float, str]]] = {}
    for _, door_id, room in targets:
        hint = room.door if room.door is not None else (room.x, room.y)
        _, _, index = project_to_corridor(hint[0], hint[1], segments)
        a, b = links[index]
        t, _, _ = _project(hint[0], hint[1], coords[a], coords[b])
        on_segment.setdefault(index, []).append((t, door_id))

    door_coords: dict[str, Point] = {}
    hallway_links: list[tuple[str, str]] = []
    for index, (a, b) in enumerate(links):
        doors = sorted(on_segment.get(index, []))
        if not doors:
            hallway_links.append((a, b))
            continue
        (ax, ay), (bx, by) = coords[a], coords[b]
        length = math.hypot(bx - ax, by - ay)
        ts = _spread_doors([t for t, _ in doors], length, "%s: corridor %s-%s" % (where, a, b))
        chain = [a]
        for t, (_, door_id) in zip(ts, doors):
            door_coords[door_id] = (ax + (bx - ax) * t / length, ay + (by - ay) * t / length)
            chain.append(door_id)
        chain.append(b)
        hallway_links.extend(zip(chain, chain[1:]))
    coords.update(door_coords)

    nodes = [_corridor_node(level, p, coords[p]) for p in plan.points]
    edges: list[dict] = []
    for a, b in hallway_links:
        stairs = any(CONNECTORS.get(p, ("",))[0] == "stairs" for p in (a, b))
        edges += _edge_rows(level, a, b, coords, "stair" if stairs else "hallway")

    for local_id, door_id, room in targets:
        # A room label is not a walkable position. Route to its mapped access
        # point and preserve the printed label independently for the map marker.
        coords[local_id] = coords[door_id]
        nodes.append(_node_row(level, door_id, coords[door_id], "door"))
        if local_id.startswith("wc"):
            nodes.append(_node_row(level, local_id, coords[local_id], "restroom",
                                   name=RESTROOM_NAME, searchAliases=RESTROOM_ALIASES, labelX=room.x, labelY=room.y))
        else:
            nodes.append(_node_row(level, local_id, coords[local_id], "room", roomNumber=room.number,
                                   name=room.name, searchAliases=room.aliases, labelX=room.x, labelY=room.y))
        edges += _edge_rows(level, door_id, local_id, coords, "door")
    return nodes, edges


def main():
    buildings = [{
        "id": BUILDING_ID,
        "name": "Grainger Hall",
        "campus": "UW-Madison",
        "address": "975 University Avenue, Madison, WI",
        "defaultFloorLevel": 1,
        "centroidLat": 43.07258,
        "centroidLon": -89.40092,
    }]

    floors, nodes, edges = [], [], []
    for level, fname, image in FLOORS:
        floors.append({
            "id": floor_id(level),
            "building": {"id": BUILDING_ID},
            "level": level,
            "name": fname,
            "planImageUrl": "/plans/%s" % image,
            "imageWidth": IMAGE_W,
            "imageHeight": IMAGE_H,
            "pixelsPerMeter": PIXELS_PER_METER,
            "calibration": {"points": CALIBRATION},
        })
        floor_nodes, floor_edges = build_floor(level, FLOOR_PLANS[level])
        nodes += floor_nodes
        edges += floor_edges

    out = {
        "Building": buildings,
        "Floor": floors,
        "MapNode": nodes,
        "NavEdge": edges,
    }

    for type_name, rows in out.items():
        folder = os.path.join(PKG_DATA, type_name)
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, "%s.json" % (rows[0]["id"] if len(rows) == 1 else type_name))
        with open(path, "w") as f:
            json.dump(rows, f, indent=2)
        print("wrote %-40s %4d rows" % (os.path.relpath(path), len(rows)))


if __name__ == "__main__":
    main()
