#!/usr/bin/env python3
"""Data prep for the Room Finder (vision-LLM wayfinding) feature.

Reads the hand-authored Grainger Hall nav graph (``data/MapNode``, ``data/Floor``) and produces
everything the vision model and the UI need:

1. ``data/Waypoint/Waypoint.json``        -- waypoints with short, model-readable labels
2. ``data/AnnotatedPlan/AnnotatedPlan.json`` -- one annotated plan image per floor
3. ``data/BuildingFacts/facts-<buildingId>.json`` -- the plain-text building facts the LLM gets.
   Named after the record id, NOT the type: a data file holding a single record has to carry that
   record's id in its filename or ``upsertSeedData`` will not load it.
4. ``ui/react/public/plans/annotated/<floorKey>.png`` -- plan images with the labels drawn on

The central trick (see the hackathon spec): the model never emits pixel coordinates. It reads the
labels we burned into the image and replies with label strings, which we look up in ``Waypoint``.
So the annotated image only has to be *legible*; its resolution is irrelevant to correctness.
Waypoint coordinates therefore stay in the ORIGINAL 1980x1530 plan space that the UI renders.

Run:  python3 tools/build_waypoints.py
"""

from __future__ import annotations

import json
import os
from collections import defaultdict

from PIL import Image, ImageDraw, ImageFont

PKG = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pkgbc231600")
DATA = os.path.join(PKG, "data")
PUBLIC_PLANS = os.path.join(PKG, "ui", "react", "public", "plans")
ANNOTATED_DIR = os.path.join(PUBLIC_PLANS, "annotated")
FONT_PATH = os.path.join(PKG, "ui", "react", "public", "styles", "fonts", "Inter_18pt-Regular.ttf")

BUILDING_ID = "grainger"

#: Stair/elevator shafts get ONE label shared across every floor they serve. This is what lets the
#: model change floors correctly -- "S1" on floor 1 and "S1" on floor 3 are the same shaft.
CONNECTOR_LABELS = {
    "stair-west": "S1",
    "elev-west-a": "E1",
    "elev-west-b": "E2",
    "elev-east": "E3",
}

#: Target width for the model-facing render. Smaller = faster + cheaper; 1500px still reads labels.
ANNOTATED_WIDTH = 1500

#: Marker colours are chosen to stay separable after palettisation (see the quantize call below)
#: and against the plan's own pastel room fills.
KIND_STYLE = {
    "hallway": {"fill": (29, 78, 216), "r": 9},  # blue
    "room": {"fill": (162, 28, 175), "r": 10},  # purple
    "stairs": {"fill": (249, 115, 22), "r": 13},  # orange
    "elevator": {"fill": (4, 120, 87), "r": 13},  # deep green
    "entrance": {"fill": (190, 18, 60), "r": 13},  # crimson
    "restroom": {"fill": (71, 85, 105), "r": 9},  # slate
}

BUILDING_FACTS = """\
# Grainger Hall -- wayfinding facts

- Grainger Hall is the business school at UW-Madison. Three floors are mapped: 1, 2 and 3.
- Room numbers encode the floor in the FIRST digit: 1xxx is on floor 1, 2xxx on floor 2,
  3xxx on floor 3. A room number alone therefore tells you its floor.
- The SECOND digit encodes the wing, not the floor:
  - x0xx and x1xx -> west wing
  - x2xx -> central wing (around the atrium / learning commons)
  - x3xx -> east wing
  - x5xx -> south-east corner
- Vertical circulation. All four shafts serve floors 1, 2 and 3:
  - S1 = West Stairs (the only mapped stairwell; NOT step-free)
  - E1 = Elevator A (west), E2 = Elevator B (west), E3 = Elevator C (east)
  - E1/E2/E3 are step-free. Prefer an elevator when the user mentions a wheelchair,
    crutches, luggage, a stroller, or asks to avoid stairs.
- S1, E1 and E2 are all on the west half of the main corridor and are the fastest way between
  floors for anything in the west or central wings. E3 is the right shaft for the east wing
  (x3xx rooms) -- using a west shaft to reach an east-wing room means a long corridor walk.
- Each floor has one main east-west corridor across the middle of the plan. Hallway waypoints
  on it are labelled <floor>-W<n> and are numbered roughly west to east.
- Restrooms sit at the central corridor junction on every floor: 1-WC, 2-WC, 3-WC.
- The only mapped building entrance is ENT-W (West Entrance) on floor 1. Anyone "coming in from
  outside" or "just got here" starts at ENT-W.
- Floor 4 exists in the real building but is NOT mapped. If the user asks for a 4xxx room, return
  status "clarify" and say floor 4 is not mapped yet.
- There is no basement in this map. Do not route to a floor other than 1, 2 or 3.
"""

#: The demo routes. Spec calls for 5, at least 2 crossing floors. These are the example chips and
#: the responses we pin as an offline fallback. Every place named here must be resolvable from the
#: labels printed on the images plus the generated name directory in the facts.
DEMO_ROUTES = [
    "I'm at the west entrance, how do I get to the Learning Commons on 3?",
    "I'm on floor 2 near 2210, I need to get to the Plenary Room",
    "Lost on floor 3 by room 3111 - where is class room 1170?",
    "I just came in the west door and class is in 2080, I'm late",
    "On crutches on floor 1 near 1210, need to reach 3335 without stairs",
]


def named_places_section(waypoints) -> str:
    """Render the name -> label directory appended to the building facts.

    The annotated images print *labels* only, so a user asking for "the Learning Commons" gives
    the model nothing to match against unless the name is written down somewhere. This directory
    is that somewhere. It rides in the cached prefix, so it is paid for once.
    """
    lines = [
        "",
        "## Named places",
        "",
        'Use this to turn a place name into a label. A name that is not listed here is not mapped:',
        'answer with status "clarify" rather than guessing which label was meant.',
        "",
    ]
    by_floor: dict[int, list[tuple[str, str]]] = {}
    for w in waypoints:
        if not w.get("name"):
            continue
        if w["kind"] in ("stairs", "elevator"):
            continue  # already covered by the vertical-circulation section above
        by_floor.setdefault(w["floorLevel"], []).append((w["label"], w["name"]))
    for level in sorted(by_floor):
        lines.append(f"Floor {level}:")
        for label, name in sorted(by_floor[level], key=lambda p: p[1].lower()):
            lines.append(f"  - {name} -> {label}")
        lines.append("")
    return "\n".join(lines)


def load(rel: str):
    with open(os.path.join(DATA, rel), encoding="utf-8") as fh:
        return json.load(fh)


def dump(rel: str, payload) -> None:
    path = os.path.join(DATA, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
        fh.write("\n")
    print(f"  wrote {os.path.relpath(path, PKG)} ({len(payload) if isinstance(payload, list) else 1} records)")


def build_waypoints(nodes, floors):
    """Assign every MapNode a short label a vision model can read off the plan."""
    by_floor = defaultdict(list)
    for node in nodes:
        by_floor[node["floor"]["id"]].append(node)

    waypoints = []
    for floor in floors:
        fid = floor["id"]
        level = floor["level"]
        floor_key = str(level)
        # Number hallway points row by row (north to south), west to east inside a row, so the
        # labels a human reads off the image increase along each corridor.
        hallways = sorted(
            (n for n in by_floor[fid] if n["kind"] == "hallway"),
            key=lambda n: (round(n["imageY"] / 40.0), n["imageX"]),
        )
        hall_labels = {n["id"]: f"{floor_key}-W{i + 1}" for i, n in enumerate(hallways)}

        for node in sorted(by_floor[fid], key=lambda n: (n["kind"], n["imageX"])):
            kind = node["kind"]
            if kind == "door":
                # A door is where a room meets its corridor; the room's own waypoint names it.
                continue
            connector = node.get("connectorKey")
            if connector:
                label = CONNECTOR_LABELS[connector]
            elif kind == "room":
                label = node["roomNumber"]
            elif kind == "restroom":
                label = f"{floor_key}-WC"
            elif kind == "entrance":
                label = "ENT-W"
            else:
                label = hall_labels[node["id"]]

            aliases = []
            if node.get("name"):
                aliases.append(node["name"])
            if kind == "room" and node.get("roomNumber"):
                aliases.append(f"room {node['roomNumber']}")

            waypoints.append(
                {
                    "id": f"wp-{BUILDING_ID}-f{level}-{label}",
                    "building": {"id": BUILDING_ID},
                    "floor": {"id": fid},
                    "floorKey": floor_key,
                    "floorLevel": level,
                    "label": label,
                    "kind": kind,
                    "imageX": node["imageX"],
                    "imageY": node["imageY"],
                    "sourceNode": node["id"],
                    **({"connectorKey": connector} if connector else {}),
                    **({"roomNumber": node["roomNumber"]} if node.get("roomNumber") else {}),
                    **({"name": node["name"]} if node.get("name") else {}),
                    **({"searchAliases": aliases} if aliases else {}),
                }
            )
    return waypoints


def _text_size(draw, text, font):
    box = draw.textbbox((0, 0), text, font=font)
    return box[2] - box[0], box[3] - box[1]


#: Directions tried for a label, in preference order, as (dx, dy) unit-ish offsets.
_DIRECTIONS = [(1, 0), (-1, 0), (0, -1), (0, 1), (1, -1), (-1, -1), (1, 1), (-1, 1)]


def _overlaps(box, taken):
    return any(box[0] < t[2] and t[0] < box[2] and box[1] < t[3] and t[1] < box[3] for t in taken)


def _place_label(draw, font, x, y, radius, text, taken, width, height):
    """Find a label box that collides with neither another label nor any waypoint dot.

    Tries 8 directions at increasing distance. ``taken`` is pre-seeded with every dot's bounding
    box (see :func:`render_annotated`) so a label can never cover a marker it doesn't belong to.
    """
    tw, th = _text_size(draw, text, font)
    pad = 5
    bw, bh = tw + 2 * pad, th + 2 * pad

    for dist in (radius + 7, radius + 30, radius + 56, radius + 88, radius + 124):
        for dx, dy in _DIRECTIONS:
            # Anchor the box on the side of the dot the direction points at.
            cx = x + dx * dist if dx >= 0 else x + dx * dist - bw
            cy = y + dy * dist if dy > 0 else (y - bh / 2 if dy == 0 else y + dy * dist - bh)
            if not (2 <= cx <= width - bw - 2 and 2 <= cy <= height - bh - 2):
                continue
            box = (cx, cy, cx + bw, cy + bh)
            if not _overlaps(box, taken):
                taken.append(box)
                return box, pad

    # Give up gracefully: stack it directly right of the dot, clamped into frame.
    cx = max(2, min(x + radius + 7, width - bw - 2))
    cy = max(2, min(y - bh / 2, height - bh - 2))
    box = (cx, cy, cx + bw, cy + bh)
    taken.append(box)
    return box, pad


def render_annotated(floor, waypoints_for_floor):
    """Burn waypoint dots + labels onto the floor plan so the model can read them."""
    src = os.path.join(PUBLIC_PLANS, os.path.basename(floor["planImageUrl"]))
    img = Image.open(src).convert("RGB")
    width, height = img.size
    draw = ImageDraw.Draw(img, "RGBA")

    label_font = ImageFont.truetype(FONT_PATH, 26)
    title_font = ImageFont.truetype(FONT_PATH, 52)
    legend_font = ImageFont.truetype(FONT_PATH, 24)

    # Connectors and the entrance are drawn last so their bigger markers sit on top.
    order = {"hallway": 0, "room": 1, "restroom": 2, "elevator": 3, "stairs": 4, "entrance": 5}
    ordered = sorted(waypoints_for_floor, key=lambda w: order.get(w["kind"], 0))

    # Reserve every dot up front so no label is ever placed over a marker.
    taken: list[tuple[float, float, float, float]] = []
    for wp in ordered:
        r = KIND_STYLE[wp["kind"]]["r"] + 4
        taken.append((wp["imageX"] - r, wp["imageY"] - r, wp["imageX"] + r, wp["imageY"] + r))

    # Reserve the title and legend panels too.
    taken.append((20, 20, 340, 120))
    taken.append((20, height - 270, 470, height - 20))

    placements = []
    for wp in ordered:
        style = KIND_STYLE[wp["kind"]]
        x, y, r = wp["imageX"], wp["imageY"], style["r"]
        box, pad = _place_label(draw, label_font, x, y, r, wp["label"], taken, width, height)
        placements.append((wp, style, box, pad))

        # Leader line when the label had to be pushed away from its dot.
        cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
        if (cx - x) ** 2 + (cy - y) ** 2 > (r + 34) ** 2:
            draw.line((x, y, cx, cy), fill=style["fill"] + (190,), width=3)

    for wp, style, _, _ in placements:
        x, y, r = wp["imageX"], wp["imageY"], style["r"]
        draw.ellipse((x - r - 3, y - r - 3, x + r + 3, y + r + 3), fill=(255, 255, 255, 235))
        draw.ellipse((x - r, y - r, x + r, y + r), fill=style["fill"] + (255,))

    for wp, style, box, pad in placements:
        draw.rounded_rectangle(box, radius=6, fill=(255, 255, 255, 240), outline=style["fill"] + (255,), width=2)
        draw.text((box[0] + pad, box[1] + pad - 2), wp["label"], font=label_font, fill=(15, 23, 42))

    # Floor title -- the model needs to know which plan it is looking at even out of order.
    title = f"FLOOR {floor['level']}"
    tw, th = _text_size(draw, title, title_font)
    draw.rounded_rectangle((28, 28, 28 + tw + 36, 28 + th + 30), radius=10, fill=(15, 23, 42, 240))
    draw.text((46, 40), title, font=title_font, fill=(255, 255, 255))

    # Legend, bottom-left, so a judge looking at the projected image can decode the dots.
    entries = [
        ("hallway", "<floor>-W<n>  hallway point"),
        ("room", "room number"),
        ("stairs", "S1  stairs (all floors)"),
        ("elevator", "E1/E2/E3  elevators (all floors)"),
        ("entrance", "ENT-W  west entrance"),
        ("restroom", "<floor>-WC  restrooms"),
    ]
    lh = 36
    lx, ly = 28, height - 28 - lh * len(entries) - 20
    lw = max(_text_size(draw, text, legend_font)[0] for _, text in entries) + 80
    draw.rounded_rectangle((lx, ly, lx + lw, ly + lh * len(entries) + 20), radius=10,
                           fill=(255, 255, 255, 242), outline=(15, 23, 42, 255), width=2)
    for i, (kind, text) in enumerate(entries):
        cy = ly + 18 + i * lh + 8
        draw.ellipse((lx + 20, cy - 9, lx + 38, cy + 9), fill=KIND_STYLE[kind]["fill"] + (255,))
        draw.text((lx + 50, cy - 13), text, font=legend_font, fill=(15, 23, 42))

    if width > ANNOTATED_WIDTH:
        img = img.resize((ANNOTATED_WIDTH, round(height * ANNOTATED_WIDTH / width)), Image.LANCZOS)

    os.makedirs(ANNOTATED_DIR, exist_ok=True)
    out = os.path.join(ANNOTATED_DIR, f"{floor['level']}.png")
    # Architectural line art + flat fills palettise cleanly; this roughly halves the bytes we
    # base64 into every LLM request without softening the label text.
    img.quantize(colors=96, method=Image.MEDIANCUT, dither=Image.Dither.NONE).save(out, optimize=True)
    print(f"  rendered {os.path.relpath(out, PKG)} {img.size} "
          f"{os.path.getsize(out) // 1024} KB, {len(waypoints_for_floor)} waypoints")
    return img.size


def main():
    nodes = load("MapNode/MapNode.json")
    floors = sorted(load("Floor/Floor.json"), key=lambda f: f["level"])

    print("waypoints:")
    waypoints = build_waypoints(nodes, floors)
    dump("Waypoint/Waypoint.json", waypoints)

    print("annotated plans:")
    plans = []
    for floor in floors:
        mine = [w for w in waypoints if w["floor"]["id"] == floor["id"]]
        aw, ah = render_annotated(floor, mine)
        plans.append(
            {
                "id": f"plan-{BUILDING_ID}-f{floor['level']}",
                "building": {"id": BUILDING_ID},
                "floor": {"id": floor["id"]},
                "floorKey": str(floor["level"]),
                "floorLevel": floor["level"],
                "floorName": floor["name"],
                # Browser-facing (served by the UI service out of ui/react/public).
                "publicUrl": f"/plans/annotated/{floor['level']}.png",
                "planImageUrl": floor["planImageUrl"],
                # Server-facing: the C3 Filesystem path the LLM call reads. Uploaded separately --
                # the app server does NOT share the workspace filesystem.
                "c3FileUrl": f"roomfinder/plans/annotated/{floor['level']}.png",
                "annotatedWidth": aw,
                "annotatedHeight": ah,
                "imageWidth": floor["imageWidth"],
                "imageHeight": floor["imageHeight"],
                "waypointCount": len(mine),
            }
        )
    dump("AnnotatedPlan/AnnotatedPlan.json", plans)

    print("building facts:")
    dump(
        # Single-record data files must be named after the record id.
        f"BuildingFacts/facts-{BUILDING_ID}.json",
        [
            {
                "id": f"facts-{BUILDING_ID}",
                "building": {"id": BUILDING_ID},
                "facts": BUILDING_FACTS + named_places_section(waypoints),
                "demoRoutes": DEMO_ROUTES,
            }
        ],
    )

    labels = [w["label"] for w in waypoints]
    print(f"\n{len(waypoints)} waypoints, {len(set(labels))} distinct labels")
    for floor in floors:
        mine = sorted(w["label"] for w in waypoints if w["floorLevel"] == floor["level"])
        print(f"  floor {floor['level']}: {' '.join(mine)}")


if __name__ == "__main__":
    main()
