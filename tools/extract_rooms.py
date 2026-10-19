#!/usr/bin/env python3
"""Extract every room printed on the Grainger Hall floor plans, and pinpoint it.

This implements the ``extract_nodes_from_plan`` stub documented in ``build_graph.py``:
it reads the rendered UW-Madison Space Management plans and returns, per floor, one
node dict per printed room number -- so the nav graph stops being limited to the two
dozen rooms somebody typed in by hand.

How a room gets found
---------------------
The plans are vector CAD exports with the text converted to outlines (see
``render_plans.py``), so there is no text layer to read, and there is no Tesseract
binary in this container. But the renders are *synthetic*: one font, one size, pure
black text on flat fills. That makes purpose-built geometry both simpler and more
reliable than a general OCR engine:

1. **Glyph detection** -- threshold the dark pixels and keep connected components of
   glyph size. Walls and furniture are far larger and fall out on size alone.
2. **Line grouping** -- union-find over glyph pairs that share a baseline and are
   horizontally adjacent. Adjacency is checked *symmetrically*; testing only
   "is the next glyph to my right" lets a group seeded in the middle of a number
   (which happens, because seeding order follows the rounded baseline) miss the
   digits to its left and silently split ``2318`` into ``23`` + ``18``.
3. **Block grouping** -- union-find again, over lines that overlap horizontally and
   stack vertically, so ``2195`` / ``Class`` / ``Room`` becomes one label block whose
   first line is the room number and whose remaining lines are the room name.

Why the characters are *not* classified
---------------------------------------
A bitmap classifier was built for step 4 and then thrown away. Held out three ways
over 81 hand-transcribed labels it read only 70 correctly, and every error was a
confident one: ``2456`` -> ``2458`` at 0.944 cosine similarity, ``2266D`` -> ``2266``
at 0.984. At 11 px tall with anti-aliasing, ``6``/``8``/``5``/``B`` differ by about
two pixels, and a cluster analysis confirmed a single tight cluster genuinely mixing
``6`` and ``8``. A silently wrong room number is the exact bug this module exists to
fix, so guessing is not an acceptable implementation.

Instead the deterministic geometry above is kept and the transcription is a reviewed,
version-controlled table: ``tools/room_labels.json``, keyed by level and by the
top-left pixel of the label's first line. ``--audit`` reports drift in both
directions -- a detected number line missing from the table, or a table key that no
longer matches a detected line -- so the table cannot rot silently against the plans.

Locating a room ("pinpointing")
-------------------------------
The label's own centre is not always a good anchor: some labels are leader-line
callouts parked in white space *outside* the room they name. So each label is snapped
into its room where possible:

* sample a ring just outside the label block and take the modal room-fill colour,
* flood-fill that region within its walls, and
* anchor at the region's **pole of inaccessibility** (the distance-transform maximum)
  rather than its centroid -- for an L-shaped room the centroid can land outside the
  polygon, and an anchor outside the room is exactly what makes a route draw through
  a wall.

Not every room has a floodable region: the big classrooms and the dining rooms are
drawn as cross-hatch or plain white rather than a flat fill, so there is no uniform
colour to grow. Those fall back to the centre of the label block (``anchor:'label'``),
which is sound because on these plans such a label is printed *inside* the room it
names -- all 29 were checked one by one against the raster.

The anchor that would be wrong is a leader-line callout parked in white space
outside its room. Those are handled by de-duplication rather than by geometry: a
callout practically always accompanies an in-room copy of the same number, so the
copy anchored in a region wins and inherits the room *name*, which usually only the
callout carries.

Usage
-----
    python3 tools/extract_rooms.py                  # summary for all four plans
    python3 tools/extract_rooms.py --audit          # table <-> plan drift report
    python3 tools/extract_rooms.py --json out.json  # full extraction
    python3 tools/extract_rooms.py --overlay        # per-floor verification overlay
"""

import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict

try:
    import cv2
    import numpy as np
except ImportError:  # pragma: no cover
    sys.exit("extract_rooms.py needs opencv-python-headless and numpy "
             "(pip install opencv-python-headless numpy)")

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
PKG = os.environ.get("MAIN_PKG_NAME", "pkgbc231600")
PLAN_DIR = os.path.join(REPO, PKG, "ui", "react", "public", "plans")
LABELS_PATH = os.path.join(HERE, "room_labels.json")

LEVELS = (1, 2, 3, 4)

# --- glyph detection -------------------------------------------------------
INK_MAX = 110          # a pixel darker than this is ink
GLYPH_H = (7, 22)      # inclusive glyph bbox height range
GLYPH_W = (2, 24)
GLYPH_A = (8, 330)     # ink pixel count

# --- room numbers ----------------------------------------------------------
# The first digit of a Grainger room number is its floor; the second is its wing.
# 2080 is printed on the level-3 plan too (the Nicholas lecture hall is two
# storeys), so the floor filter is what keeps it on floor 2 only.
ROOM_RE = r"^%d\d{3}[A-Z]?$"
# A room number is 4 digits plus an optional suffix letter, so 4-5 glyphs. The audit
# also reports 3-glyph runs, because a digit that touches a leader line or a wall
# fuses into that component and is dropped by the glyph size filter -- that is how
# 3434 on level 3 went missing, and a 3-glyph run is the only trace it leaves.
NUM_GLYPHS = (3, 5)

# --- pinpointing -----------------------------------------------------------
WHITE_MIN = 235        # all channels >= this counts as background white
RING = 6               # how far outside the label block to sample for room fill
MIN_REGION = 200       # a flood fill smaller than this is not a room
MIN_SOLIDITY = 0.35    # filled area / bounding box area; a hatch grid scores ~0.1
MIN_CLEARANCE = 6.0    # the anchor must sit >= this many px from the region edge
NECK = 5.0             # a passage narrower than 2*NECK px is a doorway, not a room


def plan_path(level):
    return os.path.join(PLAN_DIR, "floor_p%d.png" % level)


def load_labels(path=LABELS_PATH):
    """The reviewed transcription table, as {level:int -> {"x,y" -> entry}}."""
    with open(path) as fh:
        doc = json.load(fh)
    return {int(lv): tbl for lv, tbl in doc["levels"].items()}


# =========================================================================
# detection
# =========================================================================

class _UF(object):
    """Union-find over glyph / line indices."""

    def __init__(self, n):
        self.p = list(range(n))

    def find(self, a):
        while self.p[a] != a:
            self.p[a] = self.p[self.p[a]]
            a = self.p[a]
        return a

    def union(self, a, b):
        a, b = self.find(a), self.find(b)
        if a != b:
            self.p[b] = a

    def groups(self, n):
        out = defaultdict(list)
        for i in range(n):
            out[self.find(i)].append(i)
        return list(out.values())


def find_glyphs(gray):
    """Connected ink components the size of a character."""
    ink = (gray < INK_MAX).astype(np.uint8)
    count, _, stats, _ = cv2.connectedComponentsWithStats(ink, 8)
    out = []
    for i in range(1, count):
        x, y, w, h, area = stats[i]
        if (GLYPH_H[0] <= h <= GLYPH_H[1] and GLYPH_W[0] <= w <= GLYPH_W[1]
                and GLYPH_A[0] <= area <= GLYPH_A[1]):
            out.append({"x": int(x), "y": int(y), "w": int(w), "h": int(h)})
    out.sort(key=lambda g: (g["y"], g["x"]))
    return out


def group_lines(glyphs):
    """Union glyphs sharing a baseline and horizontally adjacent, in either direction."""
    n = len(glyphs)
    uf = _UF(n)
    # Sorted by y, so a glyph can only share a baseline with a bounded window of
    # neighbours; that keeps this near-linear instead of quadratic.
    for i in range(n):
        a = glyphs[i]
        acy = a["y"] + a["h"] / 2.0
        for j in range(i + 1, n):
            b = glyphs[j]
            if b["y"] - a["y"] > GLYPH_H[1]:
                break
            tall = max(a["h"], b["h"])
            if abs(acy - (b["y"] + b["h"] / 2.0)) > max(3, tall * 0.35):
                continue
            if abs(a["h"] - b["h"]) > max(3, tall * 0.45):
                continue
            gap = max(b["x"] - (a["x"] + a["w"]), a["x"] - (b["x"] + b["w"]))
            if gap <= max(6, min(a["w"], b["w"]) * 1.4):
                uf.union(i, j)
    lines = []
    for idx in uf.groups(n):
        gs = sorted((glyphs[i] for i in idx), key=lambda g: g["x"])
        lines.extend(_split_runs(gs))
    lines.sort(key=lambda l: (l["y0"], l["x0"]))
    return lines


def _line(gs):
    out = {
        "x0": min(g["x"] for g in gs), "x1": max(g["x"] + g["w"] for g in gs),
        "y0": min(g["y"] for g in gs), "y1": max(g["y"] + g["h"] for g in gs),
        "glyphs": gs,
    }
    out["h"] = out["y1"] - out["y0"]
    out["key"] = "%d,%d" % (out["x0"], out["y0"])
    return out


def _split_runs(gs):
    """Split one baseline run into separate numbers where a wall interrupts it.

    Narrow adjacent rooms put their numbers side by side with only a wall between,
    close enough that baseline adjacency unions them into a single run -- on level 4
    three closet numbers merged into one 15-glyph line and all three rooms vanished,
    because the run no longer looked like a room number to anything downstream.

    Characters inside a number are kerned 0-2 px apart, while the wall between two
    numbers leaves a much wider hole, so the split points are unambiguous outliers.
    A split is only accepted when *every* resulting chunk is a plausible room number
    length; otherwise this is a long prose word and is left alone (the audit will
    report it rather than this guessing at it).
    """
    if len(gs) <= NUM_GLYPHS[1]:
        return [_line(gs)]
    gaps = [gs[i + 1]["x"] - (gs[i]["x"] + gs[i]["w"]) for i in range(len(gs) - 1)]
    median = sorted(gaps)[len(gaps) // 2]
    cuts = [i for i, g in enumerate(gaps) if g >= 5 and g >= 3 * max(1, median)]
    if not cuts:
        return [_line(gs)]
    chunks, start = [], 0
    for i in cuts + [len(gs) - 1]:
        chunks.append(gs[start:i + 1])
        start = i + 1
    if any(not (NUM_GLYPHS[0] + 1 <= len(c) <= NUM_GLYPHS[1]) for c in chunks):
        return [_line(gs)]
    return [_line(c) for c in chunks]


def group_blocks(lines):
    """Union lines that overlap horizontally and stack vertically into label blocks."""
    n = len(lines)
    uf = _UF(n)
    for i in range(n):
        a = lines[i]
        for j in range(i + 1, n):
            b = lines[j]
            if b["y0"] - a["y1"] > 2 * max(a["h"], b["h"]):
                break
            overlap = min(a["x1"], b["x1"]) - max(a["x0"], b["x0"])
            if overlap <= 0.35 * min(a["x1"] - a["x0"], b["x1"] - b["x0"]):
                continue
            vgap = max(a["y0"], b["y0"]) - min(a["y1"], b["y1"])
            if -2 <= vgap <= 1.25 * max(a["h"], b["h"]):
                uf.union(i, j)
    blocks = []
    for idx in uf.groups(n):
        ls = sorted((lines[i] for i in idx), key=lambda l: l["y0"])
        blocks.append({
            "x0": min(l["x0"] for l in ls), "x1": max(l["x1"] for l in ls),
            "y0": min(l["y0"] for l in ls), "y1": max(l["y1"] for l in ls),
            "lines": ls, "first": ls[0],
        })
    blocks.sort(key=lambda b: (b["y0"], b["x0"]))
    return blocks


def detect(gray):
    """Returns (blocks, lines) for one plan raster."""
    lines = group_lines(find_glyphs(gray))
    return group_blocks(lines), lines


def looks_numeric(line):
    """True when a line's glyphs are all one height -- i.e. digits, not prose.

    Room numbers are a run of digits plus at most one capital, so every glyph
    reaches the same cap height. Name lines are mixed case, so ``Class`` has a tall
    ``l`` next to an x-height ``a``. Used only by ``--audit``, to tell an
    undocumented room number apart from the second line of a room name.
    """
    hs = [g["h"] for g in line["glyphs"]]
    return max(hs) - min(hs) <= 2


# =========================================================================
# pinpointing
# =========================================================================

def _fill_mask(bgr, seed_xy):
    """Flood-fill the room region of uniform fill colour containing seed_xy."""
    h, w = bgr.shape[:2]
    mask = np.zeros((h + 2, w + 2), np.uint8)
    cv2.floodFill(bgr.copy(), mask, seed_xy, 0, (12, 12, 12), (12, 12, 12),
                  cv2.FLOODFILL_MASK_ONLY | cv2.FLOODFILL_FIXED_RANGE | 8 | (1 << 8))
    return mask[1:-1, 1:-1]


def _ring_pixels(bgr, blk, pad):
    """Coordinates on a rectangle ``pad`` px outside the label block."""
    h, w = bgr.shape[:2]
    x0, y0 = max(0, blk["x0"] - pad), max(0, blk["y0"] - pad)
    x1, y1 = min(w - 1, blk["x1"] + pad), min(h - 1, blk["y1"] + pad)
    pts = []
    for x in range(x0, x1 + 1, 2):
        pts += [(x, y0), (x, y1)]
    for y in range(y0, y1 + 1, 2):
        pts += [(x0, y), (x1, y)]
    return pts


def pinpoint(bgr, blk):
    """Anchor the label inside its room.

    Returns (x, y, how). ``how`` is ``'region'`` when the point is the pole of
    inaccessibility of a flood-filled room region, or ``'label'`` when the label
    sits over empty white space -- a leader-line callout -- and there was nothing
    better to use. Rings are tried at increasing distance so that a label drawn
    inside a rounded callout box still reaches the room fill outside the box.
    """
    cx = (blk["x0"] + blk["x1"]) // 2
    cy = (blk["y0"] + blk["y1"]) // 2
    for pad in (RING, RING + 8, RING + 18):
        votes = Counter()
        ring = _ring_pixels(bgr, blk, pad)
        for (x, y) in ring:
            px = bgr[y, x]
            if px.min() >= WHITE_MIN or px.max() < 60:
                continue                  # background white, or ink / wall
            votes[(int(px[0]), int(px[1]), int(px[2]))] += 1
        if not votes:
            continue
        want = np.array(votes.most_common(1)[0][0])
        for (x, y) in ring:
            if np.abs(bgr[y, x].astype(int) - want).max() > 12:
                continue
            mask = _fill_mask(bgr, (x, y))
            if int(mask.sum()) < MIN_REGION:
                continue
            ys, xs = np.nonzero(mask)
            bbox = (ys.max() - ys.min() + 1) * (xs.max() - xs.min() + 1)
            if float(mask.sum()) / bbox < MIN_SOLIDITY:
                # A cross-hatched room is drawn as a line grid on white, and the grid
                # is connected, so flooding one hatch line yields a region the size of
                # the room that is almost all holes. Its deepest point sits *on* a
                # hatch line -- which is how 2195 first got anchored on the wall
                # between it and 2185. Solidity rejects line networks outright.
                continue
            dist = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
            spot = _deepest_core(dist, cx, cy)
            if spot is None:
                continue        # too thin to be a room: a wall shadow or a hatch line
            return spot[0], spot[1], "region"
    return cx, cy, "label"


def _deepest_core(dist, cx, cy):
    """Pole of inaccessibility of the room the label sits in, or None.

    Adjacent rooms often share a fill colour, and a doorway is a gap of that same
    colour, so one flood fill can swallow a whole bank of offices through the
    corridor -- 50 rooms came out sharing an anchor with a neighbour. Thresholding
    the distance transform severs any passage narrower than ``2 * NECK`` px, which
    is exactly what a doorway is, leaving one core per room; the core nearest this
    label is the room this label names.

    Taking the deepest point rather than the centroid matters because a centroid can
    fall outside a concave room, and an anchor outside the room is what makes a
    route draw through a wall.
    """
    core = (dist >= NECK).astype(np.uint8)
    count, lab, stats, _ = cv2.connectedComponentsWithStats(core, 8)
    best, best_key = None, None
    for i in range(1, count):
        x, y, w, h, area = stats[i]
        # distance from the label centre to this core's bounding box, 0 if inside
        dx = max(x - cx, 0, cx - (x + w - 1))
        dy = max(y - cy, 0, cy - (y + h - 1))
        key = (dx * dx + dy * dy, -area)
        if best_key is None or key < best_key:
            best, best_key = i, key
    if best is None:
        return None
    masked = np.where(lab == best, dist, 0)
    _, far, _, spot = cv2.minMaxLoc(masked)
    if far < MIN_CLEARANCE:
        return None
    return int(spot[0]), int(spot[1])


# =========================================================================
# extraction
# =========================================================================

def extract_rooms(level, labels=None):
    """Extract every room label on one floor.

    Returns ``{"level", "rooms", "audit", "stats"}``. ``rooms`` entries are
    ``{"roomNumber", "name", "imageX", "imageY", "anchor", "labelX", "labelY"}``.
    """
    table = (labels or load_labels()).get(level, {})
    path = plan_path(level)
    bgr = cv2.imread(path)
    if bgr is None:
        raise IOError("cannot read %s" % path)
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    pattern = re.compile(ROOM_RE % level)

    blocks, lines = detect(gray)
    candidates = []
    audit = {"undocumented": [], "unmatched": [], "off_floor": [], "non_room": 0}

    for blk in blocks:
        # Every line is looked up, not just the first: a number line can end up
        # below a name line when a callout box is grouped with the label it points
        # at, and a dual callout ("4121 & / 4121B") names two rooms in one block.
        numbered = []
        for ln in blk["lines"]:
            entry = table.get(ln["key"])
            if entry is None:
                continue
            number = entry.get("number")
            if not number:
                audit["non_room"] += 1
                continue
            if not pattern.match(number):
                # A room printed on a plan that is not its own floor: the two-storey
                # lecture hall shows up on both. It belongs to the floor in its number.
                audit["off_floor"].append({"number": number, "key": ln["key"]})
                continue
            numbered.append((ln, entry))
        # One block can carry two room numbers -- small neighbouring rooms stack
        # their labels, and a dual callout names two rooms at once. Then each number
        # is pinpointed from its *own* line, because the shared block centre would
        # hand both rooms the same location.
        shared = pinpoint(bgr, blk) if len(numbered) == 1 else None
        for ln, entry in numbered:
            box = blk if shared else ln
            x, y, how = shared or pinpoint(bgr, box)
            candidates.append({
                "roomNumber": entry["number"], "name": entry.get("name"),
                "imageX": x, "imageY": y, "anchor": how,
                "labelX": (box["x0"] + box["x1"]) // 2,
                "labelY": (box["y0"] + box["y1"]) // 2,
                "key": ln["key"],
            })

    # Drift, both directions. A detected number line the table has never seen is a
    # room we would silently drop; a table key that no longer matches any detected
    # line means the plan or the detector moved under the table.
    line_keys = {ln["key"] for ln in lines}
    for ln in lines:
        if ln["key"] in table:
            continue
        if NUM_GLYPHS[0] <= len(ln["glyphs"]) <= NUM_GLYPHS[1] and looks_numeric(ln):
            audit["undocumented"].append({"key": ln["key"], "glyphs": len(ln["glyphs"])})
    for key, entry in sorted(table.items()):
        if key not in line_keys:
            audit["unmatched"].append({"key": key, "number": entry.get("number")})

    # A number printed twice is a leader-line callout plus the in-room label. Keep
    # the copy actually anchored in a room region -- that is the one we can trust --
    # but inherit the room name, which usually only the callout carries.
    best = {}
    for rec in candidates:
        prev = best.get(rec["roomNumber"])
        if prev is None:
            best[rec["roomNumber"]] = rec
            continue
        # Prefer a region anchor, then the label sitting closest to the region it
        # anchored: an in-room label is a few px from its room, while a leader-line
        # callout is parked far away, so this picks the in-room copy without having
        # to trace leader lines.
        def rank(r):
            reach = (r["imageX"] - r["labelX"]) ** 2 + (r["imageY"] - r["labelY"]) ** 2
            return (r["anchor"] == "region", -reach)
        keep, drop = (rec, prev) if rank(rec) > rank(prev) else (prev, rec)
        keep["name"] = keep["name"] or drop["name"]
        best[rec["roomNumber"]] = keep

    rooms = sorted(best.values(), key=lambda r: r["roomNumber"])
    collisions = _resolve_collisions(rooms)
    return {
        "level": level,
        "rooms": rooms,
        "audit": audit,
        "stats": {
            "labels_used": len(candidates),
            "rooms_unique": len(rooms),
            "duplicates_merged": len(candidates) - len(rooms),
            "anchored_in_region": sum(1 for r in rooms if r["anchor"] == "region"),
            "anchored_on_label": sum(1 for r in rooms if r["anchor"] == "label"),
            "named": sum(1 for r in rooms if r["name"]),
            "undocumented": len(audit["undocumented"]),
            "unmatched": len(audit["unmatched"]),
            "collisions_resolved": collisions,
            "distinct_anchors": len({(r["imageX"], r["imageY"]) for r in rooms}),
        },
    }


def _resolve_collisions(rooms):
    """Force one anchor per room, in place. Returns how many were moved.

    Two rooms can still land on the same point when a room is too small to keep a
    core of its own and the nearest surviving core belongs to its neighbour. Routing
    to either would then walk you to the same door, so the room whose label is
    closest to the shared point keeps it and the others fall back to the centre of
    their own printed label -- distinct by construction, and inside the room.
    """
    moved = 0
    groups = defaultdict(list)
    for r in rooms:
        groups[(r["imageX"], r["imageY"])].append(r)
    for (ax, ay), group in groups.items():
        if len(group) < 2:
            continue
        group.sort(key=lambda r: (r["labelX"] - ax) ** 2 + (r["labelY"] - ay) ** 2)
        for r in group[1:]:
            r["imageX"], r["imageY"], r["anchor"] = r["labelX"], r["labelY"], "label"
            moved += 1
    return moved


def extract_nodes_from_plan(image_path=None, floor_level=None, labels=None):
    """Contract kept from ``build_graph.extract_nodes_from_plan``.

    Returns ``{floor_level: [node dicts]}`` so downstream graph assembly can treat
    extracted rooms exactly like the hand-authored spine nodes.
    """
    del image_path  # resolved from floor_level; kept for signature compatibility
    res = extract_rooms(floor_level, labels)
    return {floor_level: [
        {"local_id": "r%s" % r["roomNumber"].lower(), "x": r["imageX"], "y": r["imageY"],
         "kind": "room", "room_number": r["roomNumber"], "name": r["name"],
         "aliases": None, "anchor": r["anchor"]}
        for r in res["rooms"]
    ]}


# =========================================================================
# verification output
# =========================================================================

def audit_sheet(results, out_path, cols=6, scale=3):
    """Contact sheet of every drifted label, for a human to read."""
    items = []
    for res in results:
        for rec in res["audit"]["undocumented"]:
            items.append((res["level"], rec["key"], "undocumented"))
        for rec in res["audit"]["unmatched"]:
            items.append((res["level"], rec["key"], "gone:%s" % rec["number"]))
    if not items:
        return None
    cw, ch = 86, 56
    cellw, cellh = cw * scale + 8, ch * scale + 24
    rows = (len(items) + cols - 1) // cols
    sheet = np.full((rows * cellh, cols * cellw, 3), 245, np.uint8)
    plans = {lv: cv2.imread(plan_path(lv)) for lv in sorted({i[0] for i in items})}
    for pos, (lvl, key, why) in enumerate(items):
        kx, ky = (int(v) for v in key.split(","))
        im = plans[lvl]
        x0, y0 = max(0, kx - 18), max(0, ky - 14)
        sub = im[y0:min(im.shape[0], y0 + ch), x0:min(im.shape[1], x0 + cw)]
        big = cv2.resize(sub, (sub.shape[1] * scale, sub.shape[0] * scale),
                         interpolation=cv2.INTER_CUBIC)
        ry, rx = divmod(pos, cols)
        oy, ox = ry * cellh + 22, rx * cellw + 4
        hh, ww = min(big.shape[0], cellh - 26), min(big.shape[1], cellw - 8)
        sheet[oy:oy + hh, ox:ox + ww] = big[:hh, :ww]
        cv2.putText(sheet, "L%d #%d %s %s" % (lvl, pos, key, why),
                    (rx * cellw + 5, ry * cellh + 16),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.40, (0, 0, 180), 1)
    cv2.imwrite(out_path, sheet)
    return out_path


def overlay(result, out_path):
    """Draw each extracted room number at its anchor, for visual diff against the plan."""
    im = cv2.imread(plan_path(result["level"]))
    for r in result["rooms"]:
        colour = (0, 140, 0) if r["anchor"] == "region" else (0, 90, 220)
        cv2.circle(im, (r["imageX"], r["imageY"]), 6, colour, -1)
        cv2.circle(im, (r["imageX"], r["imageY"]), 6, (255, 255, 255), 1)
        cv2.line(im, (r["labelX"], r["labelY"]), (r["imageX"], r["imageY"]), colour, 1)
        for thick, col in ((3, (255, 255, 255)), (1, colour)):
            cv2.putText(im, r["roomNumber"], (r["imageX"] + 8, r["imageY"] + 4),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.40, col, thick)
    cv2.imwrite(out_path, im)
    return out_path


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--levels", default="1,2,3,4")
    ap.add_argument("--json", metavar="PATH", help="write the full extraction")
    ap.add_argument("--audit", action="store_true",
                    help="report table <-> plan drift in both directions")
    ap.add_argument("--audit-sheet", metavar="PATH", nargs="?",
                    const="/tmp/rx/audit.png", help="contact sheet of drifted labels")
    ap.add_argument("--overlay", metavar="DIR", nargs="?", const="/tmp/rx",
                    help="per-floor verification overlays")
    args = ap.parse_args()

    labels = load_labels()
    results = []
    for level in [int(s) for s in args.levels.split(",")]:
        res = extract_rooms(level, labels)
        results.append(res)
        s = res["stats"]
        print("level %d: %3d rooms (%2d dup merged, %3d named)  anchor region/label %3d/%2d"
              "  drift undoc/gone %d/%d"
              % (level, s["rooms_unique"], s["duplicates_merged"], s["named"],
                 s["anchored_in_region"], s["anchored_on_label"],
                 s["undocumented"], s["unmatched"]))
    print("total rooms extracted: %d"
          % sum(r["stats"]["rooms_unique"] for r in results))

    if args.audit:
        for res in results:
            a = res["audit"]
            if a["off_floor"]:
                print("level %d off-floor labels (kept on their own floor): %s"
                      % (res["level"], ", ".join(sorted(
                          {r["number"] for r in a["off_floor"]}))))
            for rec in a["undocumented"]:
                print("level %d UNDOCUMENTED numeric line at %s (%d glyphs)"
                      % (res["level"], rec["key"], rec["glyphs"]))
            for rec in a["unmatched"]:
                print("level %d TABLE KEY NO LONGER DETECTED %s (%s)"
                      % (res["level"], rec["key"], rec["number"]))
    if args.json:
        with open(args.json, "w") as fh:
            json.dump(results, fh, indent=2)
        print("wrote %s" % args.json)
    if args.audit_sheet:
        os.makedirs(os.path.dirname(args.audit_sheet) or ".", exist_ok=True)
        print("audit sheet: %s" % (audit_sheet(results, args.audit_sheet) or "no drift"))
    if args.overlay:
        os.makedirs(args.overlay, exist_ok=True)
        for res in results:
            print("overlay: %s" % overlay(res, os.path.join(
                args.overlay, "verify_f%d.png" % res["level"])))


if __name__ == "__main__":
    main()
