import CoreLocation
import Observation
import SwiftUI
import HoloCore

/// How the 3D view arranges the floors.
enum HoloLayout: String, CaseIterable, Identifiable {
    /// Floors pulled apart so you can see into each one.
    case exploded = "Exploded"
    /// Floors at their real spacing, as the building stands.
    case stacked = "Stacked"
    /// Only the selected floor.
    case single = "One floor"
    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .exploded: return "square.3.layers.3d"
        case .stacked: return "square.stack.3d.up.fill"
        case .single: return "square"
        }
    }
}

/// A spot the student tapped on a floor of the model, waiting for "Start here" / "Go here".
struct TappedSpot: Equatable {
    var floorId: String
    var point: CGPoint
    /// The room whose label is near the tap, if any.
    var place: MapNode?
    /// The routable node closest to the tap (what "Start here" uses).
    var nearestNodeId: String?
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
    var layout3D: HoloLayout = .exploded
    /// Bumped by the 3D view's recenter button.
    var recenter3D = 0
    /// Which leg the student is on in "Start directions" mode; nil when browsing.
    var activeLegIndex: Int?
    var tapped: TappedSpot?
    var gpsFix: GPSFix?
    var banner: String?
    var isLocating = false

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
            return
        }
        let result = router.findRoute(from: startId, to: destId, stepFree: stepFree)
        route = result
        if let firstLeg = result.legs.first {
            selectedFloorId = firstLeg.floorId
        }
    }

    // MARK: Floors

    func selectFloor(_ floorId: String) {
        selectedFloorId = floorId
        tapped = nil
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
    }

    func endDirections() {
        activeLegIndex = nil
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

    /// A tap on the 3D model: `floorId` is nil when the tap missed every floor.
    func tapMap(floorId: String?, point: CGPoint) {
        guard let floorId else {
            tapped = nil
            return
        }
        if floorId != selectedFloorId { selectFloor(floorId) }
        handleTap(at: point, floorId: floorId)
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
