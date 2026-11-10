import Foundation

public enum TardyDataError: Error, CustomStringConvertible {
    case missingResource(String)
    case noBuilding
    case unknownFloor(nodeId: String, floorId: String)

    public var description: String {
        switch self {
        case .missingResource(let name): return "Bundled map file \(name) is missing."
        case .noBuilding: return "The bundled map has no building."
        case .unknownFloor(let node, let floor): return "Node \(node) is on unknown floor \(floor)."
        }
    }
}

/// Everything known about one building: floors, the circulation graph, and
/// lookups over them. Immutable once loaded.
public final class BuildingMap: Sendable {
    /// The Grainger graph revision. Rows from older revisions are ignored so
    /// an old wall-crossing shortcut can never rejoin the current graph.
    public static let graingerRoutingRevision = "grainger-access-v2"

    public let building: Building
    /// Lowest level first.
    public let floors: [Floor]
    /// In authored order (order matters: it fixes A* tie-breaking).
    public let nodes: [MapNode]
    public let edges: [NavEdge]
    public let nodesById: [String: MapNode]
    public let floorsById: [String: Floor]

    public init(building: Building, floors: [Floor], nodes: [MapNode], edges: [NavEdge]) throws {
        self.building = building
        let ownFloors = floors.filter { $0.buildingId.isEmpty || $0.buildingId == building.id }
        self.floors = ownFloors.sorted { $0.level < $1.level }
        let floorsById = Dictionary(ownFloors.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        self.floorsById = floorsById

        let revision = building.id == "grainger" ? BuildingMap.graingerRoutingRevision : nil
        let currentNodes = nodes.filter { revision == nil || $0.routingRevision == revision }
        for node in currentNodes where floorsById[node.floorId] == nil {
            throw TardyDataError.unknownFloor(nodeId: node.id, floorId: node.floorId)
        }
        self.nodes = currentNodes
        self.edges = edges.filter { revision == nil || $0.routingRevision == revision }
        self.nodesById = Dictionary(currentNodes.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    }

    /// Load the Grainger Hall map shipped inside this package.
    public static func loadGrainger() throws -> BuildingMap {
        guard let dir = Bundle.module.url(forResource: "Resources", withExtension: nil) else {
            throw TardyDataError.missingResource("Resources")
        }
        return try load(from: dir)
    }

    /// Load a map from a directory holding Building.json, Floor.json, MapNode.json, NavEdge.json.
    public static func load(from directory: URL) throws -> BuildingMap {
        func read<T: Decodable>(_ name: String, as: T.Type) throws -> T {
            let url = directory.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: url.path) else {
                throw TardyDataError.missingResource(name)
            }
            return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
        }
        guard let building = try read("Building.json", as: [Building].self).first else {
            throw TardyDataError.noBuilding
        }
        return try BuildingMap(
            building: building,
            floors: try read("Floor.json", as: [Floor].self),
            nodes: try read("MapNode.json", as: [MapNode].self),
            edges: try read("NavEdge.json", as: [NavEdge].self)
        )
    }

    public func floor(of node: MapNode) -> Floor? { floorsById[node.floorId] }

    /// Rooms, restrooms and entrances, lowest floor first, then by title.
    public var places: [MapNode] {
        let levels = Dictionary(uniqueKeysWithValues: floors.map { ($0.id, $0.level) })
        return nodes.filter { $0.kind.isPlace }.sorted {
            let la = levels[$0.floorId] ?? 0, lb = levels[$1.floorId] ?? 0
            if la != lb { return la < lb }
            return $0.title.localizedStandardCompare($1.title) == .orderedAscending
        }
    }

    /// The building's entrance (the default start), if one is mapped.
    public var defaultStart: MapNode? { nodes.first { $0.kind == .entrance } }
}
