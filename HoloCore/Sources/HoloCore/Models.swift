import Foundation

/// What a graph vertex represents. Rooms, restrooms and entrances are places a
/// student can search for; the rest exist to shape the walkable network.
public enum NodeKind: String, Decodable, Sendable, CaseIterable {
    case room, door, hallway, elevator, stairs, restroom, entrance

    /// A node worth offering as a start or destination.
    public var isPlace: Bool {
        switch self {
        case .room, .restroom, .entrance: return true
        default: return false
        }
    }
}

/// One GPS ↔ floor-plan control point.
public struct CalibrationPoint: Decodable, Hashable, Sendable {
    public var label: String?
    public var lat: Double
    public var lon: Double
    public var imageX: Double
    public var imageY: Double

    public init(label: String? = nil, lat: Double, lon: Double, imageX: Double, imageY: Double) {
        self.label = label
        self.lat = lat
        self.lon = lon
        self.imageX = imageX
        self.imageY = imageY
    }
}

/// A floor is the pixel coordinate space that all of its geometry lives in.
/// Pixel space is authoritative; lat/lon only enters through `calibration`.
public struct Floor: Decodable, Hashable, Identifiable, Sendable {
    public var id: String
    public var buildingId: String
    public var level: Int
    public var name: String?
    public var planImageUrl: String?
    public var imageWidth: Double
    public var imageHeight: Double
    public var pixelsPerMeter: Double?
    public var calibration: [CalibrationPoint]

    /// The plan image's file name without extension, e.g. `floor_p1`.
    public var planImageName: String? {
        guard let url = planImageUrl, !url.isEmpty else { return nil }
        return URL(fileURLWithPath: url).deletingPathExtension().lastPathComponent
    }

    /// Display name, falling back to "Level N".
    public var displayName: String { nonEmpty(name) ?? "Level \(level)" }

    private enum CodingKeys: String, CodingKey {
        case id, building, level, name, planImageUrl, imageWidth, imageHeight, pixelsPerMeter, calibration
    }
    private struct Ref: Decodable { var id: String }
    private struct Calibration: Decodable { var points: [CalibrationPoint]? }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        buildingId = try c.decodeIfPresent(Ref.self, forKey: .building)?.id ?? ""
        level = try c.decode(Int.self, forKey: .level)
        name = try c.decodeIfPresent(String.self, forKey: .name)
        planImageUrl = try c.decodeIfPresent(String.self, forKey: .planImageUrl)
        imageWidth = try c.decode(Double.self, forKey: .imageWidth)
        imageHeight = try c.decode(Double.self, forKey: .imageHeight)
        pixelsPerMeter = try c.decodeIfPresent(Double.self, forKey: .pixelsPerMeter)
        calibration = try c.decodeIfPresent(Calibration.self, forKey: .calibration)?.points ?? []
    }
}

/// A graph vertex. `imageX/imageY` is the walkable routing position (for rooms,
/// the mapped access point); `labelX/labelY` is where the room's printed label is.
public struct MapNode: Decodable, Hashable, Identifiable, Sendable {
    public var id: String
    public var floorId: String
    public var kind: NodeKind
    public var imageX: Double
    public var imageY: Double
    /// `false` means a wheelchair user cannot be here (e.g. a stairwell).
    public var stepFree: Bool?
    public var name: String?
    public var roomNumber: String?
    public var searchAliases: String?
    /// Nodes sharing a key are the same stairwell or elevator shaft on different floors.
    public var connectorKey: String?
    public var labelX: Double?
    public var labelY: Double?
    public var routingRevision: String?

    /// Where to draw or hit-test this place on the plan.
    public var markerX: Double { labelX ?? imageX }
    public var markerY: Double { labelY ?? imageY }

    /// "3335", "Restrooms", … — the short name a student would say.
    public var title: String { nonEmpty(roomNumber) ?? nonEmpty(name) ?? kind.rawValue.capitalized }

    /// The room's name when the title is its number, else nil.
    public var subtitle: String? { nonEmpty(roomNumber) != nil ? nonEmpty(name) : nil }

    private enum CodingKeys: String, CodingKey {
        case id, floor, kind, imageX, imageY, stepFree, name, roomNumber, searchAliases, connectorKey, labelX, labelY, routingRevision
    }
    private struct Ref: Decodable { var id: String }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        floorId = try c.decode(Ref.self, forKey: .floor).id
        kind = try c.decode(NodeKind.self, forKey: .kind)
        imageX = try c.decode(Double.self, forKey: .imageX)
        imageY = try c.decode(Double.self, forKey: .imageY)
        stepFree = try c.decodeIfPresent(Bool.self, forKey: .stepFree)
        name = try c.decodeIfPresent(String.self, forKey: .name)
        roomNumber = try c.decodeIfPresent(String.self, forKey: .roomNumber)
        searchAliases = try c.decodeIfPresent(String.self, forKey: .searchAliases)
        connectorKey = try c.decodeIfPresent(String.self, forKey: .connectorKey)
        labelX = try c.decodeIfPresent(Double.self, forKey: .labelX)
        labelY = try c.decodeIfPresent(Double.self, forKey: .labelY)
        routingRevision = try c.decodeIfPresent(String.self, forKey: .routingRevision)
    }
}

/// A directed, same-floor walkable connection, costed in seconds.
public struct NavEdge: Decodable, Hashable, Identifiable, Sendable {
    public var id: String
    public var fromNodeId: String
    public var toNodeId: String
    public var seconds: Double
    public var meters: Double?
    public var stepFree: Bool?
    public var edgeType: String?
    public var routingRevision: String?

    private enum CodingKeys: String, CodingKey {
        case id, fromNode, toNode, seconds, meters, stepFree, edgeType, routingRevision
    }
    private struct Ref: Decodable { var id: String }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        fromNodeId = try c.decode(Ref.self, forKey: .fromNode).id
        toNodeId = try c.decode(Ref.self, forKey: .toNode).id
        seconds = try c.decode(Double.self, forKey: .seconds)
        meters = try c.decodeIfPresent(Double.self, forKey: .meters)
        stepFree = try c.decodeIfPresent(Bool.self, forKey: .stepFree)
        edgeType = try c.decodeIfPresent(String.self, forKey: .edgeType)
        routingRevision = try c.decodeIfPresent(String.self, forKey: .routingRevision)
    }
}

public struct Building: Decodable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var campus: String?
    public var address: String?
    public var defaultFloorLevel: Int?
    public var centroidLat: Double?
    public var centroidLon: Double?
}

/// JS-style truthiness for optional strings: nil and "" are both "absent".
@inline(__always)
func nonEmpty(_ s: String?) -> String? {
    guard let s, !s.isEmpty else { return nil }
    return s
}
