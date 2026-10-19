#!/usr/bin/env python3
"""
TardyAI navigation-graph authoring tool.

Generates the C3 `data/` JSON files for Grainger Hall from a compact,
human-editable description of nodes and corridor chains. Edge costs (meters and
seconds) are COMPUTED from pixel geometry so they can never drift out of sync
with node positions -- hand-authoring 60+ edge costs is where this kind of seed
data normally goes wrong.

Usage:
    python3 tools/build_graph.py

Then load it into the app with the `upsertSeedData` MCP tool.

----------------------------------------------------------------------------
HOW TO FIX A NODE POSITION
----------------------------------------------------------------------------
Node coordinates below were read off the rendered floor plans by eye and are
APPROXIMATE. To correct one: open the app, enable "Author mode" on the map page,
click the real location, and the UI shows the exact pixel coordinate to paste
here. Re-run this script, re-run upsertSeedData. Nothing else needs to change.

----------------------------------------------------------------------------
WHERE THE ROOMS COME FROM
----------------------------------------------------------------------------
`PER_FLOOR` below is no longer the room list -- it is a small set of *curated*
rooms whose names, aliases and corridor links were authored by hand for the demo
routes. **Every room on the plan** comes from `tools/extract_rooms.py`, which
reads the room-number labels off the plan raster and pinpoints each one inside
its own room. It contributed 286 rooms on levels 1-3 against the 24 that used to
be typed in here, which is why a room you could plainly see on the plan (2195,
say) could not be found in the app.

When a room appears in both, the *extracted* coordinate wins (it was derived
from the plan, not estimated by eye) and the *curated* name, aliases and
corridor link win (they are richer than the plan's own label text, and the
verified demo routes depend on those links).

----------------------------------------------------------------------------
HOW A ROOM REACHES THE CORRIDOR -- AND THE LIMIT OF IT
----------------------------------------------------------------------------
A room node is useless if nothing connects it, so each extracted room gets a
door edge to the closest point on the corridor network, inserting a junction
node there (`_attach_point`). Projecting onto the closest point of the closest
*segment* -- rather than hopping to the closest spine *vertex* -- matters a lot
at this scale: the spine has only 14 vertices spaced ~200 px apart, so a vertex
hop would send a room in the north-east corner diagonally across half the floor.

**That door edge is still a straight line, and the corridor it joins is a
hand-drawn abstraction, so a long one can cross a wall.** Routes between
circulation nodes are as good as they were; the first and last hop of a route to
one of the newly extracted rooms is an approximation of the real door. Treat the
room's *position* as authoritative (it was traced from the plan) and the final
hop as indicative. The durable fix is to trace the corridors off the raster too
-- `tools/build_corridors.py` is that work -- at which point `_attach_point`
should snap to a real corridor centreline instead of `SPINE_EDGES`.
"""

import json
import math
import os
import sys

# --------------------------------------------------------------------------
# Building constants
# --------------------------------------------------------------------------

BUILDING_ID = "grainger"
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

# Level 4 is deliberately absent even though `floor_p4.png` exists and
# `extract_rooms.py --levels 4` reads 149 rooms off it cleanly. The blocker is
# circulation, not rooms: `SPINE` was authored against levels 1-3 and does not
# describe level 4's corridors (overlay it on the plan and the east-west line
# runs through the 4251-4261 office row), so attaching rooms to it would invent
# routes through walls. Adding level 4 = trace its corridors, then one row here.
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

# --------------------------------------------------------------------------
# Shared circulation skeleton -- identical on every floor, because all three
# plans were exported from the same drawing at the same scale and orientation.
# (x, y, kind, connector_key, step_free)
# --------------------------------------------------------------------------

SPINE = [
    ("hall-w",     300, 712, "hallway",  None,          True),
    ("elev-wa",    400, 712, "elevator", "elev-west-a", True),
    ("hall-wmid",  520, 712, "hallway",  None,          True),
    ("elev-wb",    615, 712, "elevator", "elev-west-b", True),
    ("stair-w",    520, 772, "stairs",   "stair-west",  False),
    ("hall-c1",    760, 712, "hallway",  None,          True),
    ("hall-c2",   1000, 712, "hallway",  None,          True),
    ("hall-c3",   1200, 712, "hallway",  None,          True),
    ("hall-e",    1330, 712, "hallway",  None,          True),
    ("elev-e",    1410, 712, "elevator", "elev-east",   True),
    ("hall-s1",    520, 862, "hallway",  None,          True),
    ("hall-s2",    760, 862, "hallway",  None,          True),
    ("hall-s3",   1000, 862, "hallway",  None,          True),
    ("hall-s4",   1200, 862, "hallway",  None,          True),
]

SPINE_EDGES = [
    ("hall-w", "elev-wa"), ("elev-wa", "hall-wmid"), ("hall-wmid", "elev-wb"),
    ("hall-wmid", "stair-w"), ("elev-wb", "hall-c1"), ("hall-c1", "hall-c2"),
    ("hall-c2", "hall-c3"), ("hall-c3", "hall-e"), ("hall-e", "elev-e"),
    ("hall-wmid", "hall-s1"), ("hall-s1", "hall-s2"), ("hall-s2", "hall-s3"),
    ("hall-s3", "hall-s4"), ("hall-c2", "hall-s3"), ("hall-s4", "hall-e"),
]

# --------------------------------------------------------------------------
# Per-floor wing corridors, entrances, restrooms -- and the curated rooms.
# (local_id, x, y, kind, room_number, name, aliases, connects_to)
#
# A `room` row here does NOT decide that the room exists: every room comes from
# the plan (see the module docstring). A room row contributes only its name,
# aliases and corridor link, and its x/y is used only in the reported-and-kept
# case where the extractor did not find that number on the plan at all.
# --------------------------------------------------------------------------

PER_FLOOR = {
    1: [
        ("entrance-w", 250, 1300, "entrance", None, "West Entrance", "door,entry,outside", "hall-s1"),
        ("nw1", 330, 300, "hallway", None, None, None, "hall-w"),
        ("r1100", 285, 215, "room", "1100", "Morgridge Auditorium", "auditorium,lecture", "nw1"),
        ("r1140", 250, 560, "room", "1140", "Class Room 1140", None, "hall-w"),
        ("r1170", 215, 862, "room", "1170", "Class Room 1170", None, "hall-s1"),
        ("r1180", 215, 1000, "room", "1180", "Class Room 1180", None, "hall-s1"),
        ("r1210", 775, 310, "room", "1210", "Huber Undergrad Computer Lab", "computer lab,huber", "hall-c1"),
        ("r1310", 1365, 285, "room", "1310", "Plenary Room", "plenary", "elev-e"),
        ("r1250", 850, 940, "room", "1250", "Undergraduate Lounge", "lounge", "hall-s2"),
        ("wc1", 760, 735, "restroom", None, "Restrooms", "bathroom,washroom,toilet", "hall-c1"),
    ],
    2: [
        ("nw1", 330, 300, "hallway", None, None, None, "hall-w"),
        ("r2120", 305, 370, "room", "2120", "Jack F Keller Lecture Hall", "keller,lecture hall", "nw1"),
        ("r2210", 820, 385, "room", "2210", "Learning Commons", "learning commons,study", "hall-c1"),
        ("r2170", 225, 862, "room", "2170", "Class Room 2170", None, "hall-s1"),
        ("r2180", 225, 1000, "room", "2180", "Class Room 2180", None, "hall-s1"),
        ("r2310", 1245, 400, "room", "2310", "Eve/Exec/Prof MBA Suite", "mba,executive", "hall-c3"),
        ("r2335", 1478, 180, "room", "2335", "Class Room 2335", None, "elev-e"),
        ("r2290", 745, 1130, "room", "2290", "Computer Classroom 2290", "computer", "hall-s2"),
        ("r2080", 510, 1090, "room", "2080", "Nicholas Lecture Hall", "nicholas,lecture hall", "hall-s1"),
        ("wc2", 760, 735, "restroom", None, "Restrooms", "bathroom,washroom,toilet", "hall-c1"),
    ],
    3: [
        # West curved wing -- this is the demo target's corridor.
        ("nw1", 330, 300, "hallway", None, None, None, "nw2"),
        ("nw2", 350, 480, "hallway", None, None, None, "nw3"),
        ("nw3", 330, 620, "hallway", None, None, None, "hall-w"),
        ("r3112", 390, 237, "room", "3112", "Office 3112", None, "nw1"),
        ("r3111", 240, 205, "room", "3111", "Conference Room 3111", "conference", "nw1"),
        ("r3115", 245, 365, "room", "3115", "Office Suite 3115", None, "nw2"),
        ("r3150", 258, 740, "room", "3150", "Undergraduate Program Office", "advising,undergrad office", "hall-w"),
        ("r3210", 755, 385, "room", "3210", "Learning Commons", "learning commons,study", "hall-c1"),
        ("r3290", 760, 990, "room", "3290", "Undergraduate Program Office", "advising", "hall-s2"),
        ("r3335", 1478, 180, "room", "3335", "Class Room 3335", None, "elev-e"),
        ("r3340", 1450, 390, "room", "3340", "Bolz Center for Arts Admin", "bolz,arts", "hall-c3"),
        ("r3560", 1455, 1420, "room", "3560", "Seminar Room 3560", "seminar", "hall-s4"),
        ("wc3", 760, 735, "restroom", None, "Restrooms", "bathroom,washroom,toilet", "hall-c1"),
    ],
}


def extract_nodes_from_plan(image_path=None, floor_level=None, labels=None):
    """Every room printed on one floor plan, as `{floor_level: [node dicts]}`.

    Delegates to `tools/extract_rooms.py`; see that module for how the labels are
    found and how each room's anchor is placed. Kept as a function here so this
    module's only coupling to the extractor is one call with one contract.
    """
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from extract_rooms import extract_nodes_from_plan as _extract

    return _extract(image_path=image_path, floor_level=floor_level, labels=labels)


# Spacing of the junction nodes inserted where a room's door edge meets a
# corridor. Rooms whose entry points fall within one spacing of each other share
# a junction, which keeps the graph from growing a node per room without moving
# any entry point more than ~1.3 m along the corridor.
JUNCTION_SPACING_PX = 16.0

# A projected entry point this close to an existing corridor node just uses that
# node. Without it, quantisation can place a junction a pixel from a spine vertex
# and emit a zero-length hallway edge.
ENDPOINT_SNAP_PX = 10.0


def _segment_project(px, py, ax, ay, bx, by):
    """Closest point on segment AB to P, as `(distance, along, qx, qy)`.

    `along` is the distance from A to the projection measured along the segment,
    which is what the junction quantisation needs.
    """
    vx, vy = bx - ax, by - ay
    denom = vx * vx + vy * vy
    if denom == 0.0:
        return math.hypot(px - ax, py - ay), 0.0, ax, ay
    t = ((px - ax) * vx + (py - ay) * vy) / denom
    t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
    qx, qy = ax + t * vx, ay + t * vy
    return math.hypot(px - qx, py - qy), t * math.hypot(vx, vy), qx, qy


def _attach_point(coords, corridors, x, y):
    """Where a room at (x, y) should join the corridor network.

    Returns `(local_id, junction)`. `junction` is None when an existing corridor
    node is close enough to the projection to serve as the entry point; otherwise
    it is `(segment_index, step, x, y)` for a new junction node the caller must
    emit, where `step` orders the junctions along their segment.
    See the module docstring for what this approximates and what it does not.
    """
    best = None
    for index, (a, b) in enumerate(corridors):
        ax, ay = coords[a]
        bx, by = coords[b]
        dist, along, qx, qy = _segment_project(x, y, ax, ay, bx, by)
        if best is None or dist < best[0]:
            best = (dist, index, along, a, b, ax, ay, bx, by)

    _, index, along, a, b, ax, ay, bx, by = best
    length = math.hypot(bx - ax, by - ay)

    # Quantise along the segment rather than on an (x, y) grid: a diagonal
    # segment's junctions have to stay *on* the corridor, not near it.
    steps = int(length // JUNCTION_SPACING_PX)
    snapped = min(max(int(round(along / JUNCTION_SPACING_PX)), 1), max(steps, 1)) * JUNCTION_SPACING_PX
    if snapped <= ENDPOINT_SNAP_PX or snapped >= length - ENDPOINT_SNAP_PX:
        return (a if snapped * 2 <= length else b), None

    step = int(round(snapped / JUNCTION_SPACING_PX))
    ratio = snapped / length
    return "j%d-%d" % (index, step), (
        index,
        step,
        ax + ratio * (bx - ax),
        ay + ratio * (by - ay),
    )


def node_id(level, local_id):
    return "n-f%d-%s" % (level, local_id)


def floor_id(level):
    return "%s-f%d" % (BUILDING_ID, level)


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

        coords = {}
        corridors = []      # (a, b) segments a room may join
        stair_links = []    # (a, b) emitted as stair edges
        door_links = []     # (a, b) emitted as door edges
        curated = {}        # room number -> hand-authored row

        # Shared circulation skeleton.
        for local_id, x, y, kind, ckey, step_free in SPINE:
            coords[local_id] = (x, y)
            node = {
                "id": node_id(level, local_id),
                "floor": {"id": floor_id(level)},
                "kind": kind,
                "imageX": float(x),
                "imageY": float(y),
                "stepFree": step_free,
            }
            if ckey:
                node["connectorKey"] = ckey
                node["name"] = {
                    "elev-west-a": "Elevator A (west)",
                    "elev-west-b": "Elevator B (west)",
                    "elev-east": "Elevator C (east)",
                    "stair-west": "West Stairs",
                }.get(ckey)
            nodes.append(node)

        for a, b in SPINE_EDGES:
            (stair_links if "stair" in a or "stair" in b else corridors).append((a, b))

        # Curated wing corridors, the entrance and the restrooms. Curated *rooms*
        # are held back: they are emitted below at their extracted coordinate.
        for local_id, x, y, kind, room_no, name, aliases, connects_to in PER_FLOOR[level]:
            if kind == "room":
                curated[room_no] = (local_id, x, y, name, aliases, connects_to)
                continue
            coords[local_id] = (x, y)
            node = {
                "id": node_id(level, local_id),
                "floor": {"id": floor_id(level)},
                "kind": kind,
                "imageX": float(x),
                "imageY": float(y),
                "stepFree": True,
            }
            if name:
                node["name"] = name
            if aliases:
                node["searchAliases"] = aliases
            nodes.append(node)
            (corridors if kind in ("hallway", "entrance") else door_links).append(
                (local_id, connects_to)
            )

        # Every room printed on the plan.
        junctions = {}
        extracted = extract_nodes_from_plan(floor_level=level)[level]
        for room in extracted:
            hand = curated.pop(room["room_number"], None)
            local_id = hand[0] if hand else room["local_id"]
            name = (hand[3] if hand else None) or room["name"]
            coords[local_id] = (room["x"], room["y"])
            node = {
                "id": node_id(level, local_id),
                "floor": {"id": floor_id(level)},
                "kind": "room",
                "roomNumber": room["room_number"],
                "imageX": float(room["x"]),
                "imageY": float(room["y"]),
                "stepFree": True,
            }
            if name:
                node["name"] = name
            if hand and hand[4]:
                node["searchAliases"] = hand[4]
            nodes.append(node)

            if hand:
                door_links.append((local_id, hand[5]))
                continue
            target, junction = _attach_point(coords, corridors, room["x"], room["y"])
            if junction:
                junctions[target] = junction
                coords[target] = (junction[2], junction[3])
            door_links.append((local_id, target))

        # A curated room the extractor did not find is kept -- a demo route may
        # depend on it -- but it is reported, because it means a printed label was
        # missed and `extract_rooms.py --audit` should say why.
        for room_no in sorted(curated):
            local_id, x, y, name, aliases, connects_to = curated[room_no]
            print("  WARNING level %d: curated room %s is not on the plan" % (level, room_no))
            coords[local_id] = (x, y)
            node = {
                "id": node_id(level, local_id),
                "floor": {"id": floor_id(level)},
                "kind": "room",
                "roomNumber": room_no,
                "imageX": float(x),
                "imageY": float(y),
                "stepFree": True,
            }
            if name:
                node["name"] = name
            if aliases:
                node["searchAliases"] = aliases
            nodes.append(node)
            door_links.append((local_id, connects_to))

        for local_id, (_, _, jx, jy) in sorted(junctions.items()):
            nodes.append({
                "id": node_id(level, local_id),
                "floor": {"id": floor_id(level)},
                "kind": "hallway",
                "imageX": round(jx, 1),
                "imageY": round(jy, 1),
                "stepFree": True,
            })

        def add_edge(a, b, edge_type):
            ax, ay = coords[a]
            bx, by = coords[b]
            px = math.hypot(ax - bx, ay - by)
            meters = px / PIXELS_PER_METER
            seconds = meters / WALK_SPEED_MPS
            if edge_type == "door":
                seconds += DOOR_PENALTY_SECONDS
            step_free = edge_type != "stair"
            for src, dst in ((a, b), (b, a)):
                edges.append({
                    "id": "e-f%d-%s-%s" % (level, src, dst),
                    "fromNode": {"id": node_id(level, src)},
                    "toNode": {"id": node_id(level, dst)},
                    "edgeType": edge_type,
                    "seconds": round(seconds, 1),
                    "meters": round(meters, 1),
                    "stepFree": step_free,
                })

        # A corridor segment carrying junctions is emitted as the chain through
        # them, in order along the segment -- not as the original end-to-end edge,
        # which would let a route skip past every door on it.
        for index, (a, b) in enumerate(corridors):
            on_segment = sorted(
                (junction[1], local_id)
                for local_id, junction in junctions.items()
                if junction[0] == index
            )
            chain = [a] + [local_id for _, local_id in on_segment] + [b]
            for start, end in zip(chain, chain[1:]):
                add_edge(start, end, "hallway")

        for a, b in stair_links:
            add_edge(a, b, "stair")

        for a, b in door_links:
            add_edge(a, b, "door")

        print("level %d: %3d rooms on the plan, %3d corridor junctions"
              % (level, len(extracted), len(junctions)))

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
