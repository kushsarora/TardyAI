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
STUB: AUTOMATED FLOOR PLAN EXTRACTION
----------------------------------------------------------------------------
`extract_nodes_from_plan()` below is the seam where a vision pipeline would
replace this hand-authored dict. The intended shape:

    1. Rasterize the floor plan page (already done -- see tools/render_plans.py).
    2. OCR room-number labels -> text + bounding box centroid. The Grainger PDF
       has its text converted to vector outlines, so a text layer does NOT exist
       and OCR is genuinely required; do not expect pdftotext to work.
    3. Detect corridor centerlines (morphological skeletonization of the
       white/unfilled space, or a learned segmentation model).
    4. Snap each room centroid to the nearest corridor skeleton point -> that
       pair becomes a room node plus its connecting door edge.
    5. Sample the skeleton at fixed intervals -> hallway nodes; consecutive
       samples -> hallway edges.
    6. Detect elevator/stair glyphs (the blue "X" boxes and stair hatching are
       consistent across UW facilities drawings) -> connector nodes, keyed by
       clustering their x/y across floors so the same shaft gets one
       connectorKey.

    Returns the same {floor_level: [node dicts]} structure this module already
    produces, so everything downstream is unchanged.
"""

import json
import math
import os

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
# Per-floor rooms and wing corridors.
# (local_id, x, y, kind, room_number, name, aliases, connects_to)
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


def extract_nodes_from_plan(image_path, floor_level):
    """STUB -- automated floor plan extraction. See module docstring."""
    raise NotImplementedError(
        "Vision-based plan extraction is not implemented. "
        "Nodes are hand-authored in PER_FLOOR / SPINE above."
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

        # Floor-specific rooms and wing corridors.
        room_links = []
        for local_id, x, y, kind, room_no, name, aliases, connects_to in PER_FLOOR[level]:
            coords[local_id] = (x, y)
            node = {
                "id": node_id(level, local_id),
                "floor": {"id": floor_id(level)},
                "kind": kind,
                "imageX": float(x),
                "imageY": float(y),
                "stepFree": True,
            }
            if room_no:
                node["roomNumber"] = room_no
            if name:
                node["name"] = name
            if aliases:
                node["searchAliases"] = aliases
            nodes.append(node)
            room_links.append((local_id, connects_to, kind))

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

        for a, b in SPINE_EDGES:
            etype = "stair" if "stair" in a or "stair" in b else "hallway"
            add_edge(a, b, etype)

        for local_id, connects_to, kind in room_links:
            etype = "hallway" if kind in ("hallway", "entrance") else "door"
            add_edge(local_id, connects_to, etype)

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
