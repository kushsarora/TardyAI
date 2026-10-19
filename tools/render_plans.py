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
* The PDF has five pages and they map to floors one-to-one: page N -> Level N,
  written as floor_p<N>.png. Levels 4 and 5 are real floors (room numbers 4xxx
  and 5xxx; the first digit of a Grainger room number is its level), rendered
  here regardless of how many Floor records the app currently declares. All
  pages share one footprint, orientation and scale, which is why a single
  GeoCalibration works for every floor and why the floors stack correctly in a
  3D view.
* scale=2.5 yields 1980x1530 px, which must stay in sync with IMAGE_W/IMAGE_H in
  tools/build_graph.py and with Floor#imageWidth / Floor#imageHeight.
* Rendering is reproducible to the pixel: re-rendering page 1 and diffing it
  against the committed floor_p1.png gave a maximum channel difference of 0.
  That matters because tools/room_labels.json keys every room label by the pixel
  position of its text in these exact rasters; a renderer, scale or anti-aliasing
  change would silently move every key. If you upgrade pypdfium2, re-run
  tools/extract_rooms.py --audit and expect zero drift before committing the PNGs.
* --levels renders a subset (e.g. --levels 5) so adding a floor does not rewrite
  the others' files, which keeps file watchers and git diffs quiet.
"""

import argparse
import os

import pypdfium2 as pdfium

SCALE = 2.5
PAGES_TO_FLOORS = {0: 1, 1: 2, 2: 3, 3: 4, 4: 5}
DEFAULT_PDF = ".attachments/grainger-wayfinding.pdf"
OUT_DIR = os.path.join(
    os.path.dirname(__file__), "..", "pkgbc231600", "ui", "react", "public", "plans"
)


def render(pdf_path, levels=None):
    """Render the requested levels (default: every page) to OUT_DIR; return the paths."""
    os.makedirs(OUT_DIR, exist_ok=True)
    pdf = pdfium.PdfDocument(pdf_path)
    written = []
    for page_index, level in PAGES_TO_FLOORS.items():
        if levels is not None and level not in levels:
            continue
        if page_index >= len(pdf):
            print("page %d (Level %d) is not in %s; skipped" % (page_index + 1, level, pdf_path))
            continue
        img = pdf[page_index].render(scale=SCALE).to_pil()
        # Flatten to RGB. Plans are line art, so PNG compresses well and stays
        # crisp when zoomed; the output is also what the room-label table is keyed on.
        out = os.path.join(OUT_DIR, "floor_p%d.png" % level)
        img.convert("RGB").save(out, optimize=True)
        print("wrote %s %s" % (out, img.size))
        written.append(out)
    return written


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("pdf", nargs="?", default=DEFAULT_PDF, help="source PDF (default: %(default)s)")
    ap.add_argument("--levels", help="comma-separated levels to render, e.g. 5 (default: all)")
    args = ap.parse_args()
    levels = {int(s) for s in args.levels.split(",")} if args.levels else None
    render(args.pdf, levels)


if __name__ == "__main__":
    main()
