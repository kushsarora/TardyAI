import HoloCore
import SceneKit
import simd
import SwiftUI

/// The map: a holographic 3D model of Grainger Hall with the route through it.
/// Illustrative only: walls are traced from the plan images, heights are assumed.
struct Building3DView: View {
    @Bindable var model: AppModel

    var body: some View {
        ZStack(alignment: .bottom) {
            Color(HoloTheme.backdropBottom)
            if let model3D = model.model3D {
                BuildingScene(
                    map: model.map,
                    model3D: model3D,
                    config: BuildingScene.Config(
                        route: model.foundRoute,
                        activeLegIndex: model.activeLegIndex,
                        layout: model.layout3D,
                        selectedFloorId: model.selectedFloorId,
                        startNodeId: model.startId,
                        destNodeId: model.destId,
                        tapped: model.tapped,
                        gpsFix: model.gpsFix,
                        recenterToken: model.recenter3D),
                    onTap: { floorId, point in model.tapMap(floorId: floorId, point: point) })
                    .accessibilityLabel("3D model of \(model.map.building.name)")
                    .accessibilityHint("Use the route panel to choose rooms.")
                controls
            } else {
                ContentUnavailableView("3D model unavailable", systemImage: "cube.transparent",
                                       description: Text("The model data couldn’t be loaded. Search and directions still work."))
            }
        }
    }

    private var controls: some View {
        VStack(spacing: 8) {
            HStack(spacing: 8) {
                Picker("Layout", selection: $model.layout3D) {
                    ForEach(HoloLayout.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)

                Button {
                    model.recenter3D += 1
                } label: {
                    Image(systemName: "scope")
                        .font(.body.weight(.semibold))
                        .frame(width: 38, height: 32)
                        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 8))
                }
                .accessibilityLabel("Recenter the 3D view")
            }
            Text("Drag to orbit · pinch to zoom · tap a room to pick it")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text("Levels 1–3 are mapped. Higher floors aren’t yet.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(10)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
        .padding(.horizontal, 12)
        .padding(.bottom, PanelLayout.peekHeight + 12)
    }
}

/// Every colour and strength the hologram uses, in one place for tuning.
/// Glowing parts are drawn additively, so a darker colour means a fainter glow.
enum HoloTheme {
    static let backdropTop = UIColor(red: 0.03, green: 0.07, blue: 0.13, alpha: 1)
    static let backdropBottom = UIColor(red: 0.005, green: 0.012, blue: 0.03, alpha: 1)

    static let wallSide: CGFloat = 0.13
    static let wallTop: CGFloat = 0.6
    static let rim: CGFloat = 0.85
    static let grid: CGFloat = 0.22
    static let shaft: CGFloat = 0.3

    /// Brightness of the floors that aren't selected.
    static let dimmedExploded: CGFloat = 0.42
    static let dimmedStacked: CGFloat = 0.2

    /// Camera glow. Set `bloom` to false if the model looks washed out or runs slowly.
    static let bloom = true
    static let bloomIntensity: CGFloat = 0.9
    static let bloomThreshold: CGFloat = 0.7
    static let bloomBlurRadius: CGFloat = 10

    static func cyan(_ k: CGFloat) -> UIColor { UIColor(red: 0.30 * k, green: 0.88 * k, blue: 1.0 * k, alpha: 1) }
    static func amber(_ k: CGFloat) -> UIColor { UIColor(red: 1.0 * k, green: 0.74 * k, blue: 0.22 * k, alpha: 1) }
    static func green(_ k: CGFloat) -> UIColor { UIColor(red: 0.25 * k, green: 1.0 * k, blue: 0.55 * k, alpha: 1) }
    static func pink(_ k: CGFloat) -> UIColor { UIColor(red: 1.0 * k, green: 0.30 * k, blue: 0.45 * k, alpha: 1) }
    static func violet(_ k: CGFloat) -> UIColor { UIColor(red: 0.72 * k, green: 0.50 * k, blue: 1.0 * k, alpha: 1) }
    static func blue(_ k: CGFloat) -> UIColor { UIColor(red: 0.25 * k, green: 0.55 * k, blue: 1.0 * k, alpha: 1) }

    /// Drawing order. Nothing writes depth, so this alone decides what covers what:
    /// lower floors first, then the route, pins and labels on top of everything.
    enum Order {
        static let grid = -10
        static func floor(level: Int) -> Int { level * 100 }
        static let shafts = 900
        static let route = 1000
        static let markers = 1100
        static let labels = 1200
    }
}

private struct BuildingScene: UIViewRepresentable {
    struct Config: Equatable {
        var route: NavRoute?
        var activeLegIndex: Int?
        var layout: HoloLayout
        var selectedFloorId: String
        var startNodeId: String?
        var destNodeId: String?
        var tapped: TappedSpot?
        var gpsFix: GPSFix?
        var recenterToken: Int

        var floorGap: Double { layout == .exploded ? World3D.separatedFloorGap : World3D.stackedFloorGap }
        func shows(_ floorId: String) -> Bool { layout != .single || floorId == selectedFloorId }
        /// The camera is re-framed whenever this changes.
        var framingKey: String { "\(layout.rawValue)|\(layout == .single ? selectedFloorId : "")|\(recenterToken)" }
    }

    let map: BuildingMap
    let model3D: Building3DModel
    let config: Config
    let onTap: (_ floorId: String?, _ planPoint: CGPoint) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(map: map, model3D: model3D) }

    func makeUIView(context: Context) -> SCNView {
        let view = SCNView()
        view.backgroundColor = HoloTheme.backdropBottom
        view.antialiasingMode = .multisampling2X
        view.allowsCameraControl = true
        view.defaultCameraController.interactionMode = .orbitTurntable
        view.defaultCameraController.inertiaEnabled = true
        // Keep the camera above the ground so the building never flips over.
        view.defaultCameraController.minimumVerticalAngle = 6
        view.defaultCameraController.maximumVerticalAngle = 89

        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.handleTap(_:)))
        view.addGestureRecognizer(tap)

        context.coordinator.onTap = onTap
        context.coordinator.attach(to: view)
        context.coordinator.apply(config)
        return view
    }

    func updateUIView(_ view: SCNView, context: Context) {
        context.coordinator.onTap = onTap
        context.coordinator.apply(config)
    }

    final class Coordinator: NSObject {
        var onTap: ((String?, CGPoint) -> Void)?

        private let map: BuildingMap
        private let model3D: Building3DModel
        private let scene = SCNScene()
        private let cameraNode = SCNNode()
        private weak var view: SCNView?
        private var floorNodes: [String: SCNNode] = [:]
        private var overlayNode: SCNNode?
        private var applied: Config?

        init(map: BuildingMap, model3D: Building3DModel) {
            self.map = map
            self.model3D = model3D
            super.init()
        }

        func attach(to view: SCNView) {
            self.view = view
            view.scene = scene
            scene.background.contents = SceneBuilder.backdropImage()

            let camera = SCNCamera()
            camera.fieldOfView = CGFloat(Self.verticalFieldOfView)
            camera.zNear = 1
            camera.zFar = 5000
            if HoloTheme.bloom {
                camera.wantsHDR = true
                camera.wantsExposureAdaptation = false
                camera.bloomIntensity = HoloTheme.bloomIntensity
                camera.bloomThreshold = HoloTheme.bloomThreshold
                camera.bloomBlurRadius = HoloTheme.bloomBlurRadius
            }
            cameraNode.camera = camera
            scene.rootNode.addChildNode(cameraNode)
            view.pointOfView = cameraNode

            scene.rootNode.addChildNode(SceneBuilder.gridNode())

            // Each floor is one textured plane and two small meshes, so this is quick
            // enough to do right here.
            for (id, node) in SceneBuilder.floorNodes(map: map, model3D: model3D) {
                scene.rootNode.addChildNode(node)
                floorNodes[id] = node
            }
        }

        func apply(_ config: Config) {
            guard config != applied else { return }
            let previous = applied
            let animated = previous != nil
            let gap = config.floorGap
            let gapChanged = previous.map { $0.floorGap != gap } ?? false

            // Floors glide to their new height; the selected one stays bright.
            let dimmed = config.layout == .stacked ? HoloTheme.dimmedStacked : HoloTheme.dimmedExploded
            SCNTransaction.begin()
            SCNTransaction.animationDuration = animated ? 0.45 : 0
            for floor in map.floors {
                guard let node = floorNodes[floor.id] else { continue }
                node.position.y = Float(World3D.elevation(level: floor.level, floorGap: gap))
                node.isHidden = !config.shows(floor.id)
                node.opacity = floor.id == config.selectedFloorId ? 1 : dimmed
            }
            SCNTransaction.commit()

            // The route, pins and shafts are rebuilt at their final positions.
            overlayNode?.removeFromParentNode()
            let overlay = SceneBuilder.overlayNode(config: config, map: map)
            if gapChanged && animated {
                // Wait for the floors to arrive before the route reappears.
                overlay.opacity = 0
                overlay.runAction(.sequence([.wait(duration: 0.4), .fadeIn(duration: 0.25)]))
            }
            scene.rootNode.addChildNode(overlay)
            overlayNode = overlay

            if previous?.framingKey != config.framingKey { placeCamera(for: config, animated: animated) }
            applied = config
        }

        // MARK: Camera

        private static let verticalFieldOfView: Float = 50

        /// Frames whatever is on show: from the south-east for the whole building,
        /// from almost straight above for a single floor.
        private func placeCamera(for config: Config, animated: Bool) {
            guard let view, let floor = map.floors.first else { return }
            let scale = floor.pixelsPerMeter ?? 12
            let halfWidth = Float(floor.imageWidth / scale / 2)
            let halfDepth = Float(floor.imageHeight / scale / 2)

            let levels = map.floors.filter { config.shows($0.id) }.map(\.level)
            let bottom = Float(World3D.elevation(level: levels.min() ?? 1, floorGap: config.floorGap))
            let top = Float(World3D.elevation(level: levels.max() ?? 1, floorGap: config.floorGap) + model3D.wallHeightMeters)
            let halfHeight = (top - bottom) / 2
            let radius = (halfWidth * halfWidth + halfDepth * halfDepth + halfHeight * halfHeight).squareRoot()

            // A phone in portrait is limited by its width, so fit the narrower field of view.
            // Before the first layout the view has no size yet; assume a portrait phone.
            let size = view.bounds.size
            let aspect = size.width > 0 && size.height > 0 ? Float(size.width / size.height) : 0.46
            let halfVertical = Self.verticalFieldOfView / 2 * .pi / 180
            let halfHorizontal = atan(tan(halfVertical) * aspect)
            let distance = radius * 0.82 / tan(min(halfVertical, halfHorizontal))

            // Aim a little below the middle so the model sits above the route panel.
            let center = SIMD3<Float>(0, (top + bottom) / 2 - distance * tan(halfVertical) * 0.12, 0)
            let direction = simd_normalize(config.layout == .single ? SIMD3<Float>(0, 0.92, 0.40) : SIMD3<Float>(0.38, 0.55, 0.74))
            let position = center + direction * distance
            let target = SCNVector3(center.x, center.y, center.z)

            view.defaultCameraController.stopInertia()
            SCNTransaction.begin()
            SCNTransaction.animationDuration = animated ? 0.6 : 0
            cameraNode.position = SCNVector3(position.x, position.y, position.z)
            cameraNode.look(at: target)
            SCNTransaction.commit()
            view.defaultCameraController.target = target
        }

        // MARK: Tap a spot on a floor

        @objc func handleTap(_ gesture: UITapGestureRecognizer) {
            guard let view, gesture.state == .ended else { return }
            let hits = view.hitTest(gesture.location(in: view),
                                    options: [.searchMode: SCNHitTestSearchMode.all.rawValue])
            // Nearest first. A floor's plane covers its whole plan image, so skip
            // hits outside the footprint and let the tap fall through to the floor below.
            for hit in hits {
                guard let name = hit.node.name, name.hasPrefix(SceneBuilder.planPrefix) else { continue }
                let floorId = String(name.dropFirst(SceneBuilder.planPrefix.count))
                guard let floor = map.floorsById[floorId],
                      let authored = model3D.floors.first(where: { $0.floorId == floorId }) else { continue }
                // Plane-local (x right, y toward plan north, in metres) → plan pixels.
                let scale = floor.pixelsPerMeter ?? 12
                let local = hit.localCoordinates
                let x = Double(local.x) * scale + floor.imageWidth / 2
                let y = floor.imageHeight / 2 - Double(local.y) * scale
                guard authored.contains(x: x, y: y) else { continue }
                onTap?(floorId, CGPoint(x: x, y: y))
                return
            }
            onTap?(nil, .zero)
        }
    }
}

/// Turns the plan-derived model and a route into SceneKit nodes.
/// World mapping (see `World3D`): +Y up, +Z south, plan centre at the origin.
private enum SceneBuilder {
    /// A floor's tappable plane is named this plus the floor id.
    static let planPrefix = "plan:"

    // MARK: Materials

    /// A flat, unlit colour that adds its light to whatever is behind it.
    static func glow(_ color: UIColor) -> SCNMaterial {
        let material = SCNMaterial()
        material.lightingModel = .constant
        material.diffuse.contents = color
        material.blendMode = .add
        material.isDoubleSided = true
        material.writesToDepthBuffer = false
        material.readsFromDepthBuffer = false
        return material
    }

    // MARK: Backdrop and ground

    static func backdropImage() -> UIImage {
        let size = CGSize(width: 4, height: 256)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            let colors = [HoloTheme.backdropTop.cgColor, HoloTheme.backdropBottom.cgColor] as CFArray
            guard let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) else { return }
            context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 0, y: size.height), options: [])
        }
    }

    /// A 10 m grid under the building that fades out with distance, to give the model a ground.
    static func gridNode() -> SCNNode {
        let side: CGFloat = 480, cells = 48, pixels: CGFloat = 1024
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let image = UIGraphicsImageRenderer(size: CGSize(width: pixels, height: pixels), format: format).image { context in
            let cg = context.cgContext
            UIColor.black.setFill()
            cg.fill(CGRect(x: 0, y: 0, width: pixels, height: pixels))
            HoloTheme.cyan(HoloTheme.grid).setStroke()
            cg.setLineWidth(1.5)
            let step = pixels / CGFloat(cells)
            for i in 0...cells {
                let offset = CGFloat(i) * step
                cg.move(to: CGPoint(x: offset, y: 0)); cg.addLine(to: CGPoint(x: offset, y: pixels))
                cg.move(to: CGPoint(x: 0, y: offset)); cg.addLine(to: CGPoint(x: pixels, y: offset))
            }
            cg.strokePath()
            // Fade to black (which adds nothing) toward the edge.
            let colors = [UIColor.black.withAlphaComponent(0).cgColor, UIColor.black.cgColor] as CFArray
            if let fade = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0.25, 1]) {
                let middle = CGPoint(x: pixels / 2, y: pixels / 2)
                cg.drawRadialGradient(fade, startCenter: middle, startRadius: 0, endCenter: middle, endRadius: pixels / 2,
                                      options: [.drawsAfterEndLocation])
            }
        }
        let plane = SCNPlane(width: side, height: side)
        let material = glow(.white)
        material.diffuse.contents = image
        material.diffuse.mipFilter = .linear
        plane.materials = [material]
        let node = SCNNode(geometry: plane)
        node.eulerAngles.x = -Float.pi / 2
        node.position.y = -1
        node.renderingOrder = HoloTheme.Order.grid
        return node
    }

    // MARK: Floors

    /// The glowing plan texture for a floor: `holo_p1` for `floor_p1`, baked by `tools/bake_holo_plans.py`.
    static func holoImage(for floor: Floor) -> UIImage? {
        guard let name = floor.planImageName?.replacingOccurrences(of: "floor_", with: "holo_") else { return nil }
        // Xcode normally copies Plans/*.png to the bundle root; fall back to the subfolder just in case.
        if let image = UIImage(named: name) { return image }
        guard let path = Bundle.main.path(forResource: name, ofType: "png", inDirectory: "Plans") else { return nil }
        return UIImage(contentsOfFile: path)
    }

    static func floorNodes(map: BuildingMap, model3D: Building3DModel) -> [String: SCNNode] {
        var result: [String: SCNNode] = [:]
        let wallMaterials = [glow(HoloTheme.cyan(HoloTheme.wallSide)), glow(HoloTheme.cyan(HoloTheme.wallTop))]
        let rimMaterials = [glow(HoloTheme.cyan(HoloTheme.rim)), glow(HoloTheme.cyan(HoloTheme.rim))]

        for authored in model3D.floors {
            guard let floor = map.floorsById[authored.floorId] else { continue }
            let order = HoloTheme.Order.floor(level: floor.level)
            let scale = floor.pixelsPerMeter ?? 12
            let group = SCNNode()
            group.name = floor.id

            // One flat plane carries the whole floor: the real plan drawn as light on a
            // sheet of dark glass cut to the footprint. The texture's alpha does the
            // cutting and the dimming of the floors beneath; it is also what taps hit.
            let plane = SCNPlane(width: floor.imageWidth / scale, height: floor.imageHeight / scale)
            let planMaterial = SCNMaterial()
            planMaterial.lightingModel = .constant
            if let image = holoImage(for: floor) {
                planMaterial.diffuse.contents = image
                planMaterial.diffuse.mipFilter = .linear
            } else {
                planMaterial.diffuse.contents = UIColor(red: 0.02, green: 0.08, blue: 0.14, alpha: 0.6)
            }
            planMaterial.isDoubleSided = true
            planMaterial.writesToDepthBuffer = false
            planMaterial.readsFromDepthBuffer = false
            plane.materials = [planMaterial]
            let planNode = SCNNode(geometry: plane)
            planNode.name = planPrefix + floor.id
            planNode.eulerAngles.x = -Float.pi / 2
            planNode.renderingOrder = order
            group.addChildNode(planNode)

            // Walls: a translucent band along every traced wall edge, with a bright top line.
            let wallMesh = HoloGeometry.wallMesh(for: authored, floor: floor, height: model3D.wallHeightMeters)
            if let walls = geometry(wallMesh, materials: wallMaterials) {
                let node = SCNNode(geometry: walls)
                node.renderingOrder = order + 2
                group.addChildNode(node)
            }

            // Rim: a bright band around the footprint so each floor reads as one shape.
            let rimMesh = HoloGeometry.rimMesh(for: authored, floor: floor, height: 0.9)
            if let rim = geometry(rimMesh, materials: rimMaterials) {
                let node = SCNNode(geometry: rim)
                node.renderingOrder = order + 3
                group.addChildNode(node)
            }

            // "L2" tag floating off the west side.
            let tag = labelNode("L\(floor.level)", color: HoloTheme.cyan(1), height: 11)
            tag.position = SCNVector3(Float(-floor.imageWidth / scale / 2) - 12, 4, 0)
            group.addChildNode(tag)

            result[floor.id] = group
        }
        return result
    }

    /// A HoloCore mesh as SceneKit geometry: the bands (first material) and their top lines (second).
    static func geometry(_ mesh: WallMesh, materials: [SCNMaterial]) -> SCNGeometry? {
        guard !mesh.isEmpty else { return nil }
        let vertices = mesh.positions.map { SCNVector3($0.x, $0.y, $0.z) }
        let geometry = SCNGeometry(sources: [SCNGeometrySource(vertices: vertices)],
                                   elements: [SCNGeometryElement(indices: mesh.triangles, primitiveType: .triangles),
                                              SCNGeometryElement(indices: mesh.topLines, primitiveType: .line)])
        geometry.materials = materials
        return geometry
    }

    // MARK: Labels

    /// A pill-shaped text tag that always faces the camera. `height` is in metres.
    static func labelNode(_ text: String, color: UIColor, height: CGFloat) -> SCNNode {
        let attributes: [NSAttributedString.Key: Any] = [
            .font: UIFont.systemFont(ofSize: 44, weight: .bold),
            .foregroundColor: UIColor.white,
        ]
        let string = text as NSString
        let textSize = string.size(withAttributes: attributes)
        let size = CGSize(width: ceil(textSize.width) + 48, height: ceil(textSize.height) + 20)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 2
        format.opaque = false
        let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            let rect = CGRect(origin: .zero, size: size).insetBy(dx: 2, dy: 2)
            let pill = UIBezierPath(roundedRect: rect, cornerRadius: rect.height / 2)
            UIColor(red: 0.02, green: 0.06, blue: 0.10, alpha: 0.88).setFill()
            pill.fill()
            color.setStroke()
            pill.lineWidth = 3
            pill.stroke()
            string.draw(at: CGPoint(x: 24, y: 10), withAttributes: attributes)
        }
        let plane = SCNPlane(width: height * size.width / size.height, height: height)
        let material = SCNMaterial()
        material.lightingModel = .constant
        material.diffuse.contents = image
        material.isDoubleSided = true
        material.writesToDepthBuffer = false
        material.readsFromDepthBuffer = false
        plane.materials = [material]
        let node = SCNNode(geometry: plane)
        node.constraints = [SCNBillboardConstraint()]
        node.renderingOrder = HoloTheme.Order.labels
        return node
    }

    // MARK: Route, pins and shafts

    static func overlayNode(config: BuildingScene.Config, map: BuildingMap) -> SCNNode {
        let root = SCNNode()
        if config.layout != .single { root.addChildNode(shaftsNode(config: config, map: map)) }
        root.addChildNode(routeNode(config: config, map: map))
        addSpotMarkers(to: root, config: config, map: map)
        return root
    }

    static func world(x: Double, y: Double, floor: Floor, gap: Double, lift: Double = World3D.routeLift) -> SIMD3<Float> {
        let w = World3D.point(x: x, y: y, floor: floor, floorGap: gap, lift: lift)
        return SIMD3<Float>(Float(w.x), Float(w.y), Float(w.z))
    }

    /// The spot the student just tapped, and the GPS accuracy circle.
    static func addSpotMarkers(to root: SCNNode, config: BuildingScene.Config, map: BuildingMap) {
        if let spot = config.tapped, let floor = map.floorsById[spot.floorId], config.shows(floor.id) {
            let x = spot.place?.markerX ?? Double(spot.point.x), y = spot.place?.markerY ?? Double(spot.point.y)
            let ring = SCNTorus(ringRadius: 2.0, pipeRadius: 0.3)
            ring.materials = [glow(HoloTheme.violet(1))]
            let ringNode = SCNNode(geometry: ring)
            ringNode.simdPosition = world(x: x, y: y, floor: floor, gap: config.floorGap)
            ringNode.renderingOrder = HoloTheme.Order.markers
            root.addChildNode(ringNode)

            let stem = SCNCylinder(radius: 0.3, height: 6)
            stem.materials = [glow(HoloTheme.violet(0.8))]
            let stemNode = SCNNode(geometry: stem)
            stemNode.simdPosition = world(x: x, y: y, floor: floor, gap: config.floorGap) + SIMD3<Float>(0, 3, 0)
            stemNode.renderingOrder = HoloTheme.Order.markers
            root.addChildNode(stemNode)
        }
        if let fix = config.gpsFix, let floor = map.floorsById[fix.floorId], config.shows(floor.id) {
            let scale = floor.pixelsPerMeter ?? 12
            let radius = CGFloat(min(max(Double(fix.radiusPixels) / scale, 2), 60))
            let disc = SCNCylinder(radius: radius, height: 0.05)
            disc.radialSegmentCount = 48
            disc.materials = [glow(HoloTheme.blue(0.22))]
            let node = SCNNode(geometry: disc)
            node.simdPosition = world(x: Double(fix.point.x), y: Double(fix.point.y), floor: floor, gap: config.floorGap)
            node.renderingOrder = HoloTheme.Order.shafts
            root.addChildNode(node)
        }
    }

    /// Faint vertical lines where each elevator and stairwell joins the floors.
    static func shaftsNode(config: BuildingScene.Config, map: BuildingMap) -> SCNNode {
        let root = SCNNode()
        let material = glow(HoloTheme.cyan(HoloTheme.shaft))
        var byKey: [String: [(level: Int, point: SIMD3<Float>)]] = [:]
        for node in map.nodes where node.kind == .elevator || node.kind == .stairs {
            guard let key = node.connectorKey, let floor = map.floorsById[node.floorId] else { continue }
            byKey[key, default: []].append((floor.level, world(x: node.imageX, y: node.imageY, floor: floor, gap: config.floorGap)))
        }
        for stops in byKey.values {
            let sorted = stops.sorted { $0.level < $1.level }
            for (lower, upper) in zip(sorted, sorted.dropFirst()) {
                if let line = tube(from: lower.point, to: upper.point, radius: 0.22, material: material) {
                    line.renderingOrder = HoloTheme.Order.shafts
                    root.addChildNode(line)
                }
            }
        }
        return root
    }

    static func routeNode(config: BuildingScene.Config, map: BuildingMap) -> SCNNode {
        let root = SCNNode()
        let gap = config.floorGap
        let reduceMotion = UIAccessibility.isReduceMotionEnabled

        guard let route = config.route, !route.legs.isEmpty else {
            // With no route yet, still show where the start (and any destination) is.
            if let node = config.startNodeId.flatMap({ map.nodesById[$0] }), let floor = map.floorsById[node.floorId], config.shows(floor.id) {
                root.addChildNode(startMarker(at: world(x: node.imageX, y: node.imageY, floor: floor, gap: gap), animated: !reduceMotion))
            }
            if let node = config.destNodeId.flatMap({ map.nodesById[$0] }), let floor = map.floorsById[node.floorId], config.shows(floor.id) {
                root.addChildNode(destinationMarker(at: world(x: node.imageX, y: node.imageY, floor: floor, gap: gap),
                                                    title: node.title, animated: !reduceMotion))
            }
            return root
        }

        let bright = glow(HoloTheme.amber(1))
        let faint = glow(HoloTheme.amber(0.22))
        let ride = glow(HoloTheme.amber(0.7))
        /// Where the moving dot travels: the leg being walked, or the whole visible route.
        var travel: [SIMD3<Float>] = []
        var previousEnd: SIMD3<Float>?

        for (index, leg) in route.legs.enumerated() {
            guard let floor = map.floorsById[leg.floorId] else { continue }
            let visible = config.shows(leg.floorId)
            let isActive = config.activeLegIndex.map { $0 == index } ?? true
            let points = leg.points.map { world(x: $0.x, y: $0.y, floor: floor, gap: gap) }

            // The ride between floors: stair/elevator endpoint to endpoint.
            if let start = previousEnd, let first = points.first, config.layout != .single,
               let line = tube(from: start, to: first, radius: 0.4, material: config.activeLegIndex == nil ? ride : faint) {
                line.renderingOrder = HoloTheme.Order.route
                root.addChildNode(line)
            }
            if visible {
                let material = isActive ? bright : faint
                for (a, b) in zip(points, points.dropFirst()) {
                    if let line = tube(from: a, to: b, radius: 0.55, material: material) {
                        line.renderingOrder = HoloTheme.Order.route
                        root.addChildNode(line)
                    }
                }
                // Round off the corners.
                for point in points {
                    let joint = SCNSphere(radius: 0.55)
                    joint.segmentCount = 10
                    joint.materials = [material]
                    let node = SCNNode(geometry: joint)
                    node.simdPosition = point
                    node.renderingOrder = HoloTheme.Order.route
                    root.addChildNode(node)
                }
                if isActive { travel.append(contentsOf: points) }
            }
            previousEnd = leg.exitConnectorKey != nil ? points.last : nil
        }

        if let firstLeg = route.legs.first, let floor = map.floorsById[firstLeg.floorId],
           let p = firstLeg.points.first, config.shows(floor.id) {
            root.addChildNode(startMarker(at: world(x: p.x, y: p.y, floor: floor, gap: gap), animated: !reduceMotion))
        }
        if let lastLeg = route.legs.last, let floor = map.floorsById[lastLeg.floorId],
           let p = lastLeg.points.last, config.shows(floor.id) {
            let title = config.destNodeId.flatMap { map.nodesById[$0]?.title }
            root.addChildNode(destinationMarker(at: world(x: p.x, y: p.y, floor: floor, gap: gap), title: title, animated: !reduceMotion))
        }
        if !reduceMotion, let traveller = travellerNode(along: travel) { root.addChildNode(traveller) }
        return root
    }

    /// A bright dot that runs along the route over and over, showing which way to walk.
    static func travellerNode(along points: [SIMD3<Float>]) -> SCNNode? {
        guard points.count >= 2, let first = points.first else { return nil }
        var total: Float = 0
        for (a, b) in zip(points, points.dropFirst()) { total += simd_distance(a, b) }
        guard total > 1 else { return nil }
        let duration = Double(min(max(total / 28, 2.5), 7))

        let sphere = SCNSphere(radius: 1.0)
        sphere.segmentCount = 16
        sphere.materials = [glow(UIColor.white)]
        let node = SCNNode(geometry: sphere)
        node.simdPosition = first
        node.renderingOrder = HoloTheme.Order.markers

        var steps: [SCNAction] = [.move(to: SCNVector3(first.x, first.y, first.z), duration: 0), .fadeIn(duration: 0.2)]
        for (a, b) in zip(points, points.dropFirst()) {
            let share = Double(simd_distance(a, b) / total)
            steps.append(.move(to: SCNVector3(b.x, b.y, b.z), duration: duration * share))
        }
        steps.append(.fadeOut(duration: 0.2))
        steps.append(.wait(duration: 0.5))
        node.runAction(.repeatForever(.sequence(steps)))
        return node
    }

    /// "You start here": a green dot inside a ring that breathes.
    static func startMarker(at p: SIMD3<Float>, animated: Bool) -> SCNNode {
        let root = SCNNode()
        root.simdPosition = p
        let material = glow(HoloTheme.green(1))

        let dot = SCNSphere(radius: 1.2)
        dot.materials = [material]
        let dotNode = SCNNode(geometry: dot)
        dotNode.position.y = 0.6
        dotNode.renderingOrder = HoloTheme.Order.markers
        root.addChildNode(dotNode)

        let ring = SCNTorus(ringRadius: 2.6, pipeRadius: 0.25)
        ring.materials = [material]
        let ringNode = SCNNode(geometry: ring)
        ringNode.renderingOrder = HoloTheme.Order.markers
        if animated {
            ringNode.runAction(.repeatForever(.sequence([.scale(to: 1.5, duration: 0.9), .scale(to: 1.0, duration: 0.9)])))
        }
        root.addChildNode(ringNode)
        return root
    }

    /// "You're going here": a pink beam you can spot from any angle, with the room's name on top.
    static func destinationMarker(at p: SIMD3<Float>, title: String?, animated: Bool) -> SCNNode {
        let root = SCNNode()
        root.simdPosition = p
        let beamHeight: CGFloat = 16

        let beam = SCNCylinder(radius: 0.45, height: beamHeight)
        beam.radialSegmentCount = 12
        beam.materials = [glow(HoloTheme.pink(0.75))]
        let beamNode = SCNNode(geometry: beam)
        beamNode.position.y = Float(beamHeight / 2)
        beamNode.renderingOrder = HoloTheme.Order.markers
        if animated {
            beamNode.runAction(.repeatForever(.sequence([.fadeOpacity(to: 0.45, duration: 1.0), .fadeOpacity(to: 1.0, duration: 1.0)])))
        }
        root.addChildNode(beamNode)

        let ring = SCNTorus(ringRadius: 2.2, pipeRadius: 0.3)
        ring.materials = [glow(HoloTheme.pink(1))]
        let ringNode = SCNNode(geometry: ring)
        ringNode.renderingOrder = HoloTheme.Order.markers
        root.addChildNode(ringNode)

        let head = SCNSphere(radius: 1.4)
        head.materials = [glow(HoloTheme.pink(1))]
        let headNode = SCNNode(geometry: head)
        headNode.position.y = Float(beamHeight)
        headNode.renderingOrder = HoloTheme.Order.markers
        root.addChildNode(headNode)

        if let title, !title.isEmpty {
            let tag = labelNode(title, color: HoloTheme.pink(1), height: 8)
            tag.position.y = Float(beamHeight) + 7
            root.addChildNode(tag)
        }
        return root
    }

    static func tube(from a: SIMD3<Float>, to b: SIMD3<Float>, radius: CGFloat, material: SCNMaterial) -> SCNNode? {
        var delta = b - a
        let length = simd_length(delta)
        guard length > 0.01 else { return nil }
        // A cylinder looks the same either way up; pointing it upward avoids the
        // undefined "rotate straight down" case for rides down a shaft.
        if delta.y < 0 { delta = -delta }
        let cylinder = SCNCylinder(radius: radius, height: CGFloat(length))
        cylinder.radialSegmentCount = 10
        cylinder.materials = [material]
        let node = SCNNode(geometry: cylinder)
        node.simdPosition = (a + b) / 2
        node.simdOrientation = simd_quatf(from: SIMD3<Float>(0, 1, 0), to: delta / length)
        return node
    }
}
