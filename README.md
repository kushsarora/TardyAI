# HoloMap (iOS)

Indoor wayfinding for students who are late or lost: "Google Maps for inside buildings."
Demo building: **Grainger Hall**, UW–Madison.

Type a room number and you get a walking route drawn on the real floor plan, across floors. You also get an honest answer to the question that matters: *am I going to be late?*

> **HoloMap was called TardyAI** until November 2026. The GitHub repository still has the old name.
>
> **Looking for the C3 web app?** It lives on the [`C3` branch](https://github.com/kushsarora/TardyAI/tree/C3), unchanged, for reference.
> `main` is the native iOS app (SwiftUI). The routing engine, the Grainger map data and the 3D model came from that branch.

## What it does

The whole map is one 3D model. There is no separate 2D view.

- **3D hologram.** Grainger as a glowing model you can orbit and zoom: the real floor plans drawn in light on each floor, with the walls standing on them. Switch between *Exploded*, *Stacked* and *One floor* (seen from above, for reading room numbers), pick a floor with L1–L3, and recenter with one button.
- **Tap a room.** Tap any room on the model to get **Go here** or **Start** buttons.
- **Room search.** Search by number (`3335`), name (`Learning Commons`) or a term like `restroom`. You can also browse every room by floor.
- **"Start from my location".** GPS suggests a start on the floor you've picked, and the accuracy circle is drawn on that floor. GPS can't tell floors apart, so you always choose the floor.
- **A\* routing.** Routes are costed in *time*, not distance. Multi-floor routes say things like "Take Elevator A (west) up to Level 3." The route is drawn in amber with a dot running along it and a beam over the destination.
- **Step-free mode.** No stairs, elevators only. One toggle gives a different route *and* a different ETA.
- **"Am I late?"** Set your class time and you get "About 2 min late" or "3 min to spare", rechecked every 15 s.
- **Turn-by-turn directions.** A floor-by-floor walkthrough with Next/Back. It follows the map, not your real position.

## Wireframes

Screen-by-screen wireframes for the UI pass are in [`docs/wireframes/`](docs/wireframes/README.md).

## Run it on a Mac + iPhone

**Needs:** a Mac with **Xcode 16 or newer**, and an iPhone on **iOS 17 or newer**. A free Apple ID is enough; you don't need a paid developer account.

1. Clone and open the project:
   ```bash
   git clone https://github.com/kushsarora/TardyAI.git
   cd TardyAI
   open HoloMap.xcodeproj
   ```
   Xcode resolves the local `HoloCore` package on its own.
2. **Signing.** Click the blue **HoloMap** project in the sidebar, then the **HoloMap** target, then **Signing & Capabilities**.
   - Under **Team**, choose *Add an Account…*, sign in with your Apple ID, and pick your "(Personal Team)".
   - If Xcode says the bundle identifier is taken, change `com.arsalanahmad.HoloMap` to something unique, like `com.<yourname>.HoloMap`.
3. **Simulator (quickest).** Pick an iPhone simulator in the toolbar and press **⌘R**.
4. **Your iPhone.**
   - Plug it in, unlock it and tap **Trust**.
   - Pick it in the toolbar and press **⌘R**.
   - The first time, iOS asks you to turn on **Developer Mode**: go to *Settings → Privacy & Security → Developer Mode*, restart, and confirm.
   - If the app won't open with "Untrusted Developer", go to *Settings → General → VPN & Device Management*, tap your Apple ID, then **Trust**.
   - Apps signed with a free account expire after 7 days. Press ⌘R again to reinstall.

To fake being at Grainger in the simulator, use *Features → Location → Custom Location…*, for example `43.0726, -89.4010`.

## Project layout

```
HoloMap.xcodeproj/        Xcode project (iOS 17+, iPhone and iPad)
HoloMap/                  The app: SwiftUI screens, SceneKit 3D view, location
  Plans/                  holo_pN.png: the glowing floor textures (1980×1530 px)
  Assets.xcassets/        App icon, accent colour
HoloCore/                Swift package with no UI code, unit-tested on its own
  Sources/HoloCore/
    NavRouter.swift       A* router, turn-by-turn steps, room search, nearest node
    BuildingMap.swift     Loads the bundled Grainger graph
    GeoTransform.swift    GPS → floor-plan pixel suggestion
    ArrivalEstimate.swift The "am I late?" verdict
    Building3DModel.swift The plan-derived 3D model + plan→world mapping
    WallMesh.swift        Builds the light wall and rim meshes the app draws
    Resources/            Grainger data: 3 floors, 674 nodes (265 places), 1356 edges, 3D model
  Tests/                  Parity, search, GPS, arrival and 3D-data tests
tools/
  plans/                  The source UW floor plans (not shipped in the app)
  bake_holo_plans.py      Rebuilds the holo_pN textures from them
```

The app target picks up any file you add under `HoloMap/` automatically. The project uses Xcode 16's synchronized folders, so you don't need to drag files into the project.

## Tuning the 3D look

Every colour and glow strength is in `HoloTheme` at the top of `HoloMap/Building3DView.swift`. If the model looks washed out on a device, lower `bloomIntensity` or set `bloom` to `false` first (turning it off also makes drawing cheaper).

The walls are not extruded solids. `HoloCore` simplifies the traced outlines and turns each wall edge into one upright band (about 9,000 triangles per floor), which is what keeps the model quick to build and draw. The floor textures are baked, not drawn at run time; after changing a floor plan or the bake settings, run `python3 tools/bake_holo_plans.py` (needs `pillow` and `numpy`).

## Tests

`HoloCore` builds and tests with plain SwiftPM on macOS or Linux:

```bash
cd HoloCore
swift test
```

The headline test, `RouterParityTests`, replays **858 routes** recorded from the original C3 JavaScript router, in both regular and step-free mode. It requires the Swift port to produce identical paths, ETAs, distances and every word of the directions. It also checks room search and nearest-node lookups.

To regenerate that fixture after an intentional routing change, run the original router from the `C3` branch:

```bash
git worktree add ../tardyai-c3 C3
node HoloCore/scripts/make_router_oracle.js ../tardyai-c3/pkgbc231600 HoloCore/Tests/HoloCoreTests/Fixtures/router-oracle.json
```

In Xcode, open `HoloCore/Package.swift` and press **⌘U** to run the same tests.

## How routing works (two rules to know before changing anything)

- **Pixel space is authoritative, not lat/lon.** Node positions are `imageX`/`imageY` on the floor-plan image. Lat/lon only enters through each floor's `calibration` points, and only to *suggest* a pin.
- **Cross-floor movement is synthesized, never stored.** No edge spans floors. Stair and elevator nodes that share a `connectorKey` (the same shaft) are linked implicitly. The cost comes from the level difference: elevators are a 40 s wait plus 10 s per floor; stairs are 22 s per floor up and 15 s per floor down. Adding a floor stays a local change.

## Known-approximate (carried over from the C3 version)

- Node pixel positions were eyeballed off the plan images; they're the most likely visible flaw. The authoring scripts (`tools/build_graph.py`, `tools/build_3d_model.py`) are on the `C3` branch.
- `pixelsPerMeter = 12` is an estimate. It affects only the A\* heuristic and the 3D scale, never the route or its ETA.
- The two GPS calibration points are approximate building corners. Unlike the web version, the iOS app fits GPS in a y-down frame, so suggestions aren't mirrored.
- Only Levels 1–3 are mapped. Grainger has more floors; the 3D view says so rather than guessing at them.
- The 3D model is illustrative, not a surveyed BIM. Walls are traced from the plan images, and wall height (2.8 m) and floor spacing (4.2 m, or 26 m when separated) are assumptions.
- Directions don't track your real indoor position, and route times don't account for crowds, locked doors or elevator outages.
