#!/usr/bin/env python3
"""Bake the hologram floor textures used by the 3D view.

Reads HoloMap/Plans/floor_pN.png (the real UW floor plans) and writes
HoloMap/Plans/holo_pN.png: linework as cyan light, room-type fills as a dim
tint, everything outside the building footprint black. The 3D view draws these
with additive blending, so black means "nothing there".

    pip install pillow numpy
    python3 tools/bake_holo_plans.py
"""
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
PLANS = ROOT / "HoloMap" / "Plans"
MODEL = ROOT / "HoloCore" / "Sources" / "HoloCore" / "Resources" / "Grainger3D.json"
FLOORS = ROOT / "HoloCore" / "Sources" / "HoloCore" / "Resources" / "Floor.json"

LINE = np.array([0.45, 0.92, 1.0])   # linework colour
FILL_GAIN = 0.30                     # how much of a room's colour survives
LINE_GAIN = 0.95


def bake(plan: Image.Image, outline, openings) -> Image.Image:
    rgb = np.asarray(plan.convert("RGB"), dtype=np.float32) / 255.0
    lum = rgb @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    mx, mn = rgb.max(axis=2), rgb.min(axis=2)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)

    # Dark, unsaturated pixels are walls, doors and text.
    line = np.clip((0.55 - lum) / 0.40, 0, 1) * np.clip(1 - sat * 1.5, 0, 1)
    # Saturated pixels are the room-type fills and icons.
    fill = np.clip((sat - 0.12) / 0.5, 0, 1)

    out = line[..., None] * LINE * LINE_GAIN + fill[..., None] * rgb * FILL_GAIN
    out = np.clip(out, 0, 1)

    mask = Image.new("L", plan.size, 0)
    draw = ImageDraw.Draw(mask)
    draw.polygon([tuple(p) for p in outline], fill=255)
    for ring in openings:
        draw.polygon([tuple(p) for p in ring], fill=0)
    mask = mask.filter(ImageFilter.GaussianBlur(1.5))
    out *= (np.asarray(mask, dtype=np.float32) / 255.0)[..., None]
    return Image.fromarray((out * 255).astype(np.uint8), "RGB")


def main():
    model = json.loads(MODEL.read_text())
    floors = {f["id"]: f for f in json.loads(FLOORS.read_text())}
    for authored in model["floors"]:
        floor = floors[authored["floorId"]]
        name = Path(floor["planImageUrl"]).stem          # floor_p1
        plan = Image.open(PLANS / f"{name}.png")
        target = PLANS / f"{name.replace('floor_', 'holo_')}.png"
        bake(plan, authored["outline"], authored["openings"]).save(target, optimize=True)
        print("wrote", target.relative_to(ROOT))


if __name__ == "__main__":
    main()
