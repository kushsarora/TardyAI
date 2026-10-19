#!/usr/bin/env python3
"""
Render the UW-Madison Grainger Hall wayfinding PDF into floor plan PNGs for the
TardyAI frontend.

    pip3 install pypdfium2 pillow
    python3 tools/render_plans.py

Source PDF:
    https://uwconferencesevents.wisc.edu/app/uploads/2023/08/Grainger-Wayfinding-Combined.pdf

Notes for whoever maintains this:

* The PDF is pure VECTOR line art with all text converted to outlines. There is
  no text layer and no embedded raster image, so `pdftotext` yields nothing and
  `pypdf`'s image extraction yields nothing. Rendering is the only way in, and
  reading room numbers programmatically would require OCR.
* Pages map to floors as: page 1 -> Level 1, page 2 -> Level 2, page 3 -> Level 3,
  page 4 -> Level 4. All pages share one footprint, orientation and scale, which
  is why a single GeoCalibration works for every floor and why the floors stack
  correctly in a 3D view.
* scale=2.5 yields 1980x1530 px, which must stay in sync with IMAGE_W/IMAGE_H in
  tools/build_graph.py and with Floor#imageWidth / Floor#imageHeight.
"""

import os
import sys

import pypdfium2 as pdfium

SCALE = 2.5
PAGES_TO_FLOORS = {0: 1, 1: 2, 2: 3, 3: 4}
OUT_DIR = os.path.join(
    os.path.dirname(__file__), "..", "pkgbc231600", "ui", "react", "public", "plans"
)


def main(pdf_path):
    os.makedirs(OUT_DIR, exist_ok=True)
    pdf = pdfium.PdfDocument(pdf_path)
    for page_index, level in PAGES_TO_FLOORS.items():
        if page_index >= len(pdf):
            continue
        img = pdf[page_index].render(scale=SCALE).to_pil()
        # Flatten to RGB and save as JPEG-quality PNG alternative: plans are
        # line art, so PNG compresses well and stays crisp when zoomed.
        out = os.path.join(OUT_DIR, "floor_p%d.png" % level)
        img.convert("RGB").save(out, optimize=True)
        print("wrote %s %s" % (out, img.size))


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else ".attachments/grainger-wayfinding.pdf"
    main(src)
