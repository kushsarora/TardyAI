import SceneKit
import simd
import SwiftUI
import TardyCore

/// The 3D cutaway of Grainger Hall with the same route as the 2D map.
/// Illustrative only: walls are traced from the plan images, heights are assumed.
struct Building3DView: View {
    @Bindable var model: AppModel
    @State private var ready = false

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            Color(.secondarySystemBackground)
            if let model3D = model.model3D {
                BuildingScene(
                    map: model.map,
                    model3D: model3D,
                    planImages: planImages,
                    config: BuildingScene.Config(
                        route: model.foundRoute,
                        activeLegIndex: model.activeLegIndex,
                        separated: model.separatedFloors,
                        visibleFloorIds: model.showAllFloors3D ? Set(model.map.floors.map(\.id)) : [model.selectedFloorId],
                        startNodeId: model.startId,
                        destNodeId: model.destId),
                    onReady: { ready = true })
                if !ready {
                    ProgressView("Building 3D model…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                controls
                    .padding(.leading, 12)
                    .padding(.bottom, PanelLayout.peekHeight + 16)
            } else {
                ContentUnavailableView("3D model unavailable", systemImage: "cube.transparent",
                                       description: Text("The 2D map still has your route."))
            }
        }
    }

    private var planImages: [String: UIImage] {
        var images: [String: UIImage] = [:]
        for floor in model.map.floors {
            if let image = model.planImage(for: floor) { images[floor.id] = image }
        }
        return images
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle(isOn: $model.separatedFloors) { Text("Separate floors") }
            Toggle(isOn: $model.showAllFloors3D) { Text("All floors") }
            Text("Drag to orbit · pinch to zoom · two fingers to pan")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .font(.footnote)
        .fixedSize()
        .padding(12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
    }
}

private struct BuildingScene: UIViewRepresentable {
    struct Config: Equatable {
        var route: NavRoute?
        var activeLegIndex: Int?
        var separated: Bool
        var visibleFloorIds: Set<String>
        var startNodeId: String?
        var destNodeId: String?
        var floorGap: Double { separated ? World3D.separatedFloorGap : World3D.stackedFloorGap }
    }

    let map: BuildingMap
    let model3D: Building3DModel
    let planImages: [String: UIImage]
    let config: Config
    let onReady: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(map: map, model3D: model3D) }

    func makeUIView(context: Context) -> SCNView {
        let view = SCNView()
        view.backgroundColor = .secondarySystemBackground
        view.antialiasingMode = .multisampling4X
        view.allowsCameraControl = true
        view.defaultCameraController.interactionMode = .orbitTurntable
        view.defaultCameraController.maximumVerticalAngle = 88
        context.coordinator.attach(to: view, planImages: planImages, onReady: onReady)
        context.coordinator.apply(config)
        return view
    }

    func updateUIView(_ view: SCNView, context: Context) {
        context.coordinator.apply(config)
    }

    final class Coordinator {
        private let map: BuildingMap
        private let model3D: Building3DModel
        private let scene = SCNScene()
        private let cameraNode = SCNNode()
        private weak var view: SCNView?
        private var floorNodes: [String: SCNNode] = [:]
        private var routeNode: SCNNode?
        private var applied: Config?
        private var pending: Config?
        private var appliedGap: Double?

        init(map: BuildingMap, model3D: Building3DModel) {
            self.map = map
            self.model3D = model3D
        }

        func attach(to view: SCNView, planImages: [String: UIImage], onReady: @escaping () -> Void) {
            self.view = view
            view.scene = scene

            let camera = SCNCamera()
            camera.fieldOfView = 50
            camera.zNear = 0.5
            camera.zFar = 4000
            cameraNode.camera = camera
            scene.rootNode.addChildNode(cameraNode)
            view.pointOfView = cameraNode

            let ambient = SCNNode()
            ambient.light = SCNLight()
            ambient.light?.type = .ambient
            ambient.light?.intensity = 550
            scene.rootNode.addChildNode(ambient)

            let sun = SCNNode()
            sun.light = SCNLight()
            sun.light?.type = .directional
            sun.light?.intensity = 750
            sun.eulerAngles = SCNVector3(-Float.pi / 3, Float.pi / 5, 0)
            scene.rootNode.addChildNode(sun)

            // Tessellating a few hundred traced wall outlines takes a moment; do it off the main thread.
            let map = self.map, model3D = self.model3D
            DispatchQueue.global(qos: .userInitiated).async {
                let built = SceneBuilder.floorNodes(map: map, model3D: model3D, planImages: planImages)
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    for (id, node) in built {
                        self.scene.rootNode.addChildNode(node)
                        self.floorNodes[id] = node
                    }
                    let config = self.pending
                    self.applied = nil
                    if let config { self.apply(config) }
                    onReady()
                }
            }
        }

        func apply(_ config: Config) {
            pending = config
            guard !floorNodes.isEmpty, config != applied else { return }
            let gap = config.floorGap

            for floor in map.floors {
                guard let node = floorNodes[floor.id] else { continue }
                node.position.y = Float(World3D.elevation(level: floor.level, floorGap: gap))
                node.isHidden = !config.visibleFloorIds.contains(floor.id)
            }

            routeNode?.removeFromParentNode()
            routeNode = SceneBuilder.routeNode(config: config, map: map)
            if let routeNode { scene.rootNode.addChildNode(routeNode) }

            if appliedGap != gap { placeCamera(gap: gap) }
            appliedGap = gap
            applied = config
        }

        private func placeCamera(gap: Double) {
            let top = World3D.elevation(level: map.floors.last?.level ?? 1, floorGap: gap)
            let center = SCNVector3(0, Float(top / 2), 0)
            cameraNode.position = SCNVector3(0, Float(top / 2 + 110), 150)
            cameraNode.look(at: center)
            view?.defaultCameraController.target = center
        }
    }
}

/// Turns the plan-derived model and a route into SceneKit nodes.
/// World mapping (see `World3D`): +Y up, +Z south, plan centre at the origin.
private enum SceneBuilder {
    static let slabColors: [UIColor] = [
        UIColor(red: 0.86, green: 0.90, blue: 0.83, alpha: 1),
        UIColor(red: 0.84, green: 0.90, blue: 0.87, alpha: 1),
        UIColor(red: 0.86, green: 0.88, blue: 0.93, alpha: 1),
    ]

    static func floorNodes(map: BuildingMap, model3D: Building3DModel, planImages: [String: UIImage]) -> [String: SCNNode] {
        var result: [String: SCNNode] = [:]
        let wallMaterial = SCNMaterial()
        wallMaterial.diffuse.contents = UIColor(red: 0.74, green: 0.80, blue: 0.75, alpha: 1)

        for authored in model3D.floors {
            guard let floor = map.floorsById[authored.floorId] else { continue }
            let group = SCNNode()
            group.name = floor.id

            // Slab: the footprint with its openings cut out, 0.65 m thick, top at y = 0.
            let slabShape = SCNShape(path: path([authored.outline] + authored.openings, floor: floor), extrusionDepth: 0.65)
            let slabMaterial = SCNMaterial()
            slabMaterial.diffuse.contents = slabColors[(floor.level - 1) % slabColors.count]
            slabShape.materials = [slabMaterial]
            let slab = SCNNode(geometry: slabShape)
            slab.eulerAngles.x = -Float.pi / 2
            slab.position.y = -0.325
            group.addChildNode(slab)

            // The real floor plan, clipped to the footprint, lying on the slab.
            if let image = planImages[floor.id],
               let masked = clippedPlan(image, outline: authored.outline, openings: authored.openings, floor: floor) {
                let scale = floor.pixelsPerMeter ?? 12
                let plane = SCNPlane(width: floor.imageWidth / scale, height: floor.imageHeight / scale)
                let material = SCNMaterial()
                material.diffuse.contents = masked
                material.lightingModel = .lambert
                material.isDoubleSided = true
                material.transparencyMode = .aOne
                plane.materials = [material]
                let planNode = SCNNode(geometry: plane)
                planNode.eulerAngles.x = -Float.pi / 2
                planNode.position.y = 0.03
                group.addChildNode(planNode)
            }

            // Walls: traced contours extruded to the assumed wall height, merged into one draw call.
            let walls = SCNNode()
            for wall in authored.walls where wall.outline.count >= 3 {
                let shape = SCNShape(path: path([wall.outline] + wall.holes, floor: floor),
                                     extrusionDepth: model3D.wallHeightMeters)
                shape.materials = [wallMaterial]
                let node = SCNNode(geometry: shape)
                node.eulerAngles.x = -Float.pi / 2
                node.position.y = Float(model3D.wallHeightMeters / 2)
                walls.addChildNode(node)
            }
            group.addChildNode(walls.flattenedClone())

            result[floor.id] = group
        }
        return result
    }

    /// Rings of plan pixels → one even-odd path in the shape's local XY plane.
    /// Local (x, y) = world (x, -z); the node is then tipped flat by -90° about X.
    static func path(_ rings: [[[Double]]], floor: Floor) -> UIBezierPath {
        let path = UIBezierPath()
        path.usesEvenOddFillRule = true
        for ring in rings where ring.count >= 3 {
            for (i, p) in ring.enumerated() where p.count >= 2 {
                let w = World3D.point(x: p[0], y: p[1], floor: floor, floorGap: 0)
                let point = CGPoint(x: w.x, y: -w.z)
                if i == 0 { path.move(to: point) } else { path.addLine(to: point) }
            }
            path.close()
        }
        return path
    }

    static func clippedPlan(_ image: UIImage, outline: [[Double]], openings: [[[Double]]], floor: Floor) -> UIImage? {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = false
        let size = image.size
        let sx = size.width / floor.imageWidth, sy = size.height / floor.imageHeight
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.image { _ in
            let clip = UIBezierPath()
            clip.usesEvenOddFillRule = true
            for ring in [outline] + openings where ring.count >= 3 {
                for (i, p) in ring.enumerated() where p.count >= 2 {
                    let point = CGPoint(x: p[0] * sx, y: p[1] * sy)
                    if i == 0 { clip.move(to: point) } else { clip.addLine(to: point) }
                }
                clip.close()
            }
            clip.addClip()
            image.draw(in: CGRect(origin: .zero, size: size))
        }
    }

    static func routeNode(config: BuildingScene.Config, map: BuildingMap) -> SCNNode? {
        guard let route = config.route, !route.legs.isEmpty else { return endpointsOnly(config: config, map: map) }
        let root = SCNNode()
        let gap = config.floorGap
        func world(_ p: RoutePoint, _ floor: Floor) -> SCNVector3 {
            let w = World3D.point(x: p.x, y: p.y, floor: floor, floorGap: gap, lift: World3D.routeLift)
            return SCNVector3(Float(w.x), Float(w.y), Float(w.z))
        }

        var previousEnd: SCNVector3?
        for (index, leg) in route.legs.enumerated() {
            guard let floor = map.floorsById[leg.floorId] else { continue }
            let visible = config.visibleFloorIds.contains(leg.floorId)
            let dimmed = config.activeLegIndex.map { $0 != index } ?? false
            let points = leg.points.map { world($0, floor) }
            if visible {
                let color = UIColor.systemBlue.withAlphaComponent(dimmed ? 0.3 : 1)
                for (a, b) in zip(points, points.dropFirst()) {
                    if let tube = tube(from: a, to: b, radius: 0.45, color: color) { root.addChildNode(tube) }
                }
            }
            // The ride between floors: stair/elevator endpoint to endpoint.
            if let start = previousEnd, let first = points.first, config.visibleFloorIds.count > 1,
               let tube = tube(from: start, to: first, radius: 0.35, color: UIColor.systemOrange.withAlphaComponent(dimmed ? 0.4 : 1)) {
                root.addChildNode(tube)
            }
            previousEnd = leg.exitConnectorKey != nil ? points.last : nil
        }

        if let firstLeg = route.legs.first, let floor = map.floorsById[firstLeg.floorId],
           let p = firstLeg.points.first, config.visibleFloorIds.contains(floor.id) {
            root.addChildNode(marker(at: world(p, floor), color: .systemGreen))
        }
        if let lastLeg = route.legs.last, let floor = map.floorsById[lastLeg.floorId],
           let p = lastLeg.points.last, config.visibleFloorIds.contains(floor.id) {
            root.addChildNode(marker(at: world(p, floor), color: .systemRed))
        }
        return root
    }

    /// With no route yet, still show where the start (and any destination) is.
    static func endpointsOnly(config: BuildingScene.Config, map: BuildingMap) -> SCNNode? {
        let root = SCNNode()
        for (id, color) in [(config.startNodeId, UIColor.systemGreen), (config.destNodeId, UIColor.systemRed)] {
            guard let id, let node = map.nodesById[id], let floor = map.floorsById[node.floorId],
                  config.visibleFloorIds.contains(floor.id) else { continue }
            let w = World3D.point(x: node.imageX, y: node.imageY, floor: floor, floorGap: config.floorGap, lift: World3D.routeLift)
            root.addChildNode(marker(at: SCNVector3(Float(w.x), Float(w.y), Float(w.z)), color: color))
        }
        return root
    }

    static func tube(from a: SCNVector3, to b: SCNVector3, radius: CGFloat, color: UIColor) -> SCNNode? {
        let va = SIMD3<Float>(a.x, a.y, a.z), vb = SIMD3<Float>(b.x, b.y, b.z)
        let delta = vb - va
        let length = simd_length(delta)
        guard length > 0.01 else { return nil }
        let cylinder = SCNCylinder(radius: radius, height: CGFloat(length))
        cylinder.radialSegmentCount = 10
        let material = SCNMaterial()
        material.diffuse.contents = color
        material.lightingModel = .constant
        cylinder.materials = [material]
        let node = SCNNode(geometry: cylinder)
        node.simdPosition = (va + vb) / 2
        node.simdOrientation = simd_quatf(from: SIMD3<Float>(0, 1, 0), to: delta / length)
        return node
    }

    static func marker(at p: SCNVector3, color: UIColor) -> SCNNode {
        let sphere = SCNSphere(radius: 1.3)
        let material = SCNMaterial()
        material.diffuse.contents = color
        material.lightingModel = .constant
        sphere.materials = [material]
        let node = SCNNode(geometry: sphere)
        node.position = SCNVector3(p.x, p.y + 1.6, p.z)
        return node
    }
}
