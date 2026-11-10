import Foundation

/// The plan-derived 3D cutaway of Grainger Hall (illustrative, not a surveyed
/// BIM). All outlines are in floor-plan pixels; see `World3D` for the mapping
/// into meters. Rendering geometry never creates walkable edges.
public struct Building3DModel: Decodable, Sendable {
    public struct Wall: Decodable, Sendable {
        /// Closed polygon, plan pixels as [x, y].
        public var outline: [[Double]]
        public var holes: [[[Double]]]
    }

    public struct FloorModel: Decodable, Sendable {
        public var level: Int
        public var floorId: String
        /// The slab footprint.
        public var outline: [[Double]]
        /// Cut-outs in the slab (atria, open stairwells).
        public var openings: [[[Double]]]
        public var walls: [Wall]
    }

    public var imageWidth: Double
    public var imageHeight: Double
    public var wallHeightMeters: Double
    public var floorHeightMeters: Double
    public var description: String?
    public var floors: [FloorModel]

    public static func loadGrainger() throws -> Building3DModel {
        guard let url = Bundle.module.url(forResource: "Resources", withExtension: nil)?
            .appendingPathComponent("Grainger3D.json"),
            FileManager.default.fileExists(atPath: url.path) else {
            throw TardyDataError.missingResource("Grainger3D.json")
        }
        return try JSONDecoder().decode(Building3DModel.self, from: Data(contentsOf: url))
    }
}

/// Plan pixels → 3D world meters. World +Y is up, +Z points south (down the
/// plan image), and the plan's centre sits at the origin.
public enum World3D {
    /// Real storey spacing; floors drawn "stacked" use this.
    public static let stackedFloorGap = 4.2
    /// Exaggerated spacing so you can see between floors.
    public static let separatedFloorGap = 26.0
    /// How far the route line floats above the floor.
    public static let routeLift = 0.45

    public struct Point: Hashable, Sendable {
        public var x: Double, y: Double, z: Double
    }

    public static func elevation(level: Int, floorGap: Double) -> Double { Double(level - 1) * floorGap }

    public static func point(x px: Double, y py: Double, floor: Floor, floorGap: Double, lift: Double = 0) -> Point {
        let scale = floor.pixelsPerMeter ?? 12
        return Point(x: (px - floor.imageWidth / 2) / scale,
                     y: elevation(level: floor.level, floorGap: floorGap) + lift,
                     z: (py - floor.imageHeight / 2) / scale)
    }
}
