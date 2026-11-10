import CoreLocation
import Observation
import SwiftUI
import TardyCore

enum MapMode: String, CaseIterable, Identifiable {
    case plan = "2D"
    case model = "3D"
    var id: String { rawValue }
}

/// A spot the student tapped on the floor plan, waiting for "Start here" / "Go here".
struct TappedSpot: Equatable {
    var floorId: String
    var point: CGPoint
    /// The room whose label is near the tap, if any.
    var place: MapNode?
    /// The routable node closest to the tap (what "Start here" uses).
    var nearestNodeId: String?
}

/// Asks the map to frame a region of a floor plan (plan pixels).
struct FocusRequest: Equatable {
    var id: Int
    var floorId: String
    var rect: CGRect?
}

/// Where the GPS suggested the student is, for drawing the accuracy circle.
struct GPSFix: Equatable {
    var floorId: String
    var point: CGPoint
    var radiusPixels: CGFloat
}

@MainActor
@Observable
final class AppModel {
    let map: BuildingMap
    let router: NavRouter
    let model3D: Building3DModel?

    private(set) var startId: String?
    private(set) var destId: String?
    private(set) var stepFree = false
    private(set) var route: NavRoute?

    var selectedFloorId: String
    var mapMode: MapMode = .plan
    var separatedFloors = true
    var showAllFloors3D = true
    /// Which leg the student is on in "Start directions" mode; nil when browsing.
    var activeLegIndex: Int?
    var tapped: TappedSpot?
    var gpsFix: GPSFix?
    var banner: String?
    var isLocating = false
    private(set) var focus: FocusRequest

    @ObservationIgnored private var planImages: [String: UIImage] = [:]
    private let location = LocationProvider()

    init() throws {
        let map = try BuildingMap.loadGrainger()
        self.map = map
        router = NavRouter(map: map)
        model3D = try? Building3DModel.loadGrainger()
        let start = map.defaultStart
        startId = start?.id
        let firstFloor = start?.floorId ?? map.floors.first?.id ?? ""
        selectedFloorId = firstFloor
        focus = FocusRequest(id: 0, floorId: firstFloor, rect: nil)
    }

    // MARK: Lookups

    var selectedFloor: Floor? { map.floorsById[selectedFloorId] }
    var startNode: MapNode? { startId.flatMap { map.nodesById[$0] } }
    var destNode: MapNode? { destId.flatMap { map.nodesById[$0] } }
    var foundRoute: NavRoute? { route?.found == true ? route : nil }

    func floorName(_ floorId: String) -> String { map.floorsById[floorId]?.displayName ?? "" }

    /// A one-line name for a start or destination.
    func label(_ node: MapNode?) -> String {
        guard let node else { return "" }
        switch node.kind {
        case .room, .restroom, .entrance:
            if let subtitle = node.subtitle { return "\(node.title) · \(subtitle)" }
            return node.title
        case .elevator, .stairs:
            return connectorLabel(node)
        default:
            return "Pinned spot"
        }
    }

    func planImage(for floor: Floor) -> UIImage? {
        guard let name = floor.planImageName else { return nil }
        if let cached = planImages[name] { return cached }
        // Xcode normally copies Plans/*.png to the bundle root; fall back to the subfolder just in case.
        let image = UIImage(named: name)
            ?? Bundle.main.path(forResource: name, ofType: "png", inDirectory: "Plans").flatMap(UIImage.init(contentsOfFile:))
        planImages[name] = image
        return image
    }

    func search(_ query: String) -> [MapNode] {
        router.searchRooms(query, limit: 50).filter { $0.kind.isPlace }
    }

    // MARK: Choosing endpoints

    func setStart(_ id: String?) {
        startId = id
        if id != gpsStartId { gpsFix = nil }
        recompute()
    }

    func setDestination(_ id: String?) {
        destId = id
        recompute()
    }

    func setStepFree(_ value: Bool) {
        stepFree = value
        recompute()
    }

    func swapEndpoints() {
        guard destId != nil else { return }
        let oldStart = startId
        startId = destId
        destId = oldStart
        gpsFix = nil
        recompute()
    }

    func clearRoute() {
        destId = nil
        recompute()
    }

    private func recompute() {
        activeLegIndex = nil
        tapped = nil
        guard startId != nil, destId != nil else {
            route = nil
            requestFocus(on: selectedFloorId)
            return
        }
        let result = router.findRoute(from: startId, to: destId, stepFree: stepFree)
        route = result
        if let firstLeg = result.legs.first {
            selectedFloorId = firstLeg.floorId
        }
        requestFocus(on: selectedFloorId)
    }

    // MARK: Floors and framing

    func selectFloor(_ floorId: String) {
        selectedFloorId = floorId
        tapped = nil
        requestFocus(on: floorId)
    }

    func requestFocus(on floorId: String) {
        focus = FocusRequest(id: focus.id + 1, floorId: floorId, rect: routeBounds(on: floorId))
    }

    /// Bounding box of everything worth seeing on a floor: its route legs and pins.
    func routeBounds(on floorId: String) -> CGRect? {
        var points: [CGPoint] = []
        for (index, leg) in (foundRoute?.legs ?? []).enumerated() where leg.floorId == floorId {
            if let active = activeLegIndex, active != index { continue }
            points += leg.points.map { CGPoint(x: $0.x, y: $0.y) }
        }
        if points.isEmpty {
            for node in [startNode, destNode].compactMap({ $0 }) where node.floorId == floorId {
                points.append(CGPoint(x: node.imageX, y: node.imageY))
            }
        }
        guard let first = points.first else { return nil }
        var rect = CGRect(origin: first, size: .zero)
        for p in points.dropFirst() { rect = rect.union(CGRect(origin: p, size: .zero)) }
        return rect.insetBy(dx: -90, dy: -90)
    }

    // MARK: Directions mode

    func startDirections() {
        guard let route = foundRoute, !route.legs.isEmpty else { return }
        showLeg(0)
    }

    func showLeg(_ index: Int) {
        guard let route = foundRoute, route.legs.indices.contains(index) else { return }
        activeLegIndex = index
        selectedFloorId = route.legs[index].floorId
        requestFocus(on: selectedFloorId)
    }

    func endDirections() {
        activeLegIndex = nil
        requestFocus(on: selectedFloorId)
    }

    // MARK: Map taps

    func handleTap(at point: CGPoint, floorId: String) {
        // Prefer a room whose printed label is near the tap.
        let radius = 70.0
        var best: MapNode?
        var bestDistance = radius * radius
        for node in map.nodes where node.floorId == floorId && node.kind.isPlace {
            let dx = node.markerX - point.x, dy = node.markerY - point.y
            let d = dx * dx + dy * dy
            if d < bestDistance {
                bestDistance = d
                best = node
            }
        }
        let nearest = router.nearestNode(floorId: floorId, x: point.x, y: point.y) { $0.kind != .door }
        tapped = TappedSpot(floorId: floorId, point: point, place: best, nearestNodeId: nearest?.id)
    }

    func startFromTap() {
        guard let spot = tapped else { return }
        setStart(spot.place?.id ?? spot.nearestNodeId)
    }

    func goToTap() {
        guard let place = tapped?.place else { return }
        setDestination(place.id)
    }

    // MARK: GPS suggestion

    @ObservationIgnored private var gpsStartId: String?

    /// Suggest a start from GPS on the *selected* floor. GPS can't tell floors
    /// apart, so the student must have picked the right one.
    func useMyLocation() {
        isLocating = true
        location.requestOneFix { [weak self] result in
            Task { @MainActor in self?.applyLocation(result) }
        }
    }

    private func applyLocation(_ result: Result<CLLocation, Error>) {
        isLocating = false
        guard let floor = selectedFloor else { return }
        switch result {
        case .failure(let error):
            banner = (error as? LocationProvider.Failure)?.message ?? "Couldn’t get your location. Tap the map to set your start instead."
        case .success(let fix):
            guard let fit = GeoTransform(points: floor.calibration) else {
                banner = "This floor isn’t calibrated for GPS yet. Tap the map to set your start."
                return
            }
            let p = fit.project(lat: fix.coordinate.latitude, lon: fix.coordinate.longitude)
            let margin = 0.15
            let inside = p.x > -floor.imageWidth * margin && p.x < floor.imageWidth * (1 + margin)
                && p.y > -floor.imageHeight * margin && p.y < floor.imageHeight * (1 + margin)
            guard inside else {
                let center = CLLocation(latitude: map.building.centroidLat ?? 0, longitude: map.building.centroidLon ?? 0)
                let km = fix.distance(from: center) / 1000
                banner = String(format: "You seem to be %.1f km from %@. Tap the map to set your start instead.", km, map.building.name)
                return
            }
            guard let node = router.nearestNode(floorId: floor.id, x: p.x, y: p.y, where: { $0.kind != .door }) else { return }
            gpsStartId = node.id
            setStart(node.id)
            gpsFix = GPSFix(floorId: floor.id, point: CGPoint(x: p.x, y: p.y),
                            radiusPixels: CGFloat(fix.horizontalAccuracy * (floor.pixelsPerMeter ?? fit.pixelsPerMeter)))
            banner = "Start set near \(label(node)) on \(floor.displayName), ±\(Int(fix.horizontalAccuracy)) m. GPS can’t tell floors apart — check the floor."
        }
    }
}
