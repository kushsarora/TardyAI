import Foundation

/// A lightweight wall mesh for one floor: a vertical face along every wall
/// edge, plus the line along its top. Built by hand because extruding the
/// traced outlines with SceneKit's shape tessellator was too heavy for a phone.
/// Positions are metres in the floor's own frame (y = 0 is the floor), using
/// the `World3D` mapping.
public struct WallMesh: Sendable, Equatable {
    public var positions: [SIMD3<Float>] = []
    /// One per position: the outward-facing horizontal direction of its wall face, for lighting.
    public var normals: [SIMD3<Float>] = []
    /// Two triangles per wall edge.
    public var triangles: [UInt32] = []
    /// One segment per wall edge, along the top.
    public var topLines: [UInt32] = []

    public var isEmpty: Bool { triangles.isEmpty }

    /// Adds a band of the given height standing on a closed ring of ground points.
    /// Each edge gets its own four vertices so every wall face is lit flat.
    public mutating func addBand(ring: [SIMD3<Float>], height: Float) {
        guard ring.count >= 3 else { return }
        for i in ring.indices {
            let a = ring[i], b = ring[(i + 1) % ring.count]
            let dx = b.x - a.x, dz = b.z - a.z
            let length = (dx * dx + dz * dz).squareRoot()
            guard length > 0 else { continue }
            let normal = SIMD3<Float>(dz / length, 0, -dx / length)
            let base = UInt32(positions.count)
            positions.append(a)
            positions.append(b)
            positions.append(SIMD3<Float>(b.x, b.y + height, b.z))
            positions.append(SIMD3<Float>(a.x, a.y + height, a.z))
            normals.append(contentsOf: [normal, normal, normal, normal])
            triangles.append(contentsOf: [base, base + 1, base + 2, base, base + 2, base + 3])
            topLines.append(contentsOf: [base + 3, base + 2])
        }
    }
}

public enum HoloGeometry {
    /// The traced outlines are stair-stepped pixel contours; anything closer
    /// than this many plan pixels to a straight line is dropped.
    public static let defaultTolerance = 1.5

    /// Every wall of a floor as one mesh.
    public static func wallMesh(for authored: Building3DModel.FloorModel, floor: Floor,
                                height: Double, tolerance: Double = defaultTolerance) -> WallMesh {
        var mesh = WallMesh()
        for wall in authored.walls {
            for ring in [wall.outline] + wall.holes {
                mesh.addBand(ring: groundRing(ring, floor: floor, tolerance: tolerance), height: Float(height))
            }
        }
        return mesh
    }

    /// The footprint and its openings as a low band, for the floor's rim.
    public static func rimMesh(for authored: Building3DModel.FloorModel, floor: Floor, height: Double) -> WallMesh {
        var mesh = WallMesh()
        for ring in [authored.outline] + authored.openings {
            mesh.addBand(ring: groundRing(ring, floor: floor, tolerance: 0), height: Float(height))
        }
        return mesh
    }

    static func groundRing(_ ring: [[Double]], floor: Floor, tolerance: Double) -> [SIMD3<Float>] {
        simplify(ring: ring, tolerance: tolerance).map { p in
            let w = World3D.point(x: p[0], y: p[1], floor: floor, floorGap: 0)
            return SIMD3<Float>(Float(w.x), 0, Float(w.z))
        }
    }

    /// Douglas–Peucker on a closed ring. Returns [x, y] pairs; never fewer than 3
    /// unless the input was already degenerate.
    public static func simplify(ring: [[Double]], tolerance: Double) -> [[Double]] {
        var points = ring.filter { $0.count >= 2 }
        if points.count > 1, points.first == points.last { points.removeLast() }
        guard tolerance > 0, points.count > 4 else { return points }

        // Split the ring at point 0 and the point farthest from it, then simplify each half.
        var far = 0
        var farDistance = -1.0
        for (i, p) in points.enumerated() {
            let d = hypot(p[0] - points[0][0], p[1] - points[0][1])
            if d > farDistance { farDistance = d; far = i }
        }
        guard far > 0 else { return points }
        var keep = [Bool](repeating: false, count: points.count + 1)
        let closed = points + [points[0]]
        keep[0] = true; keep[far] = true; keep[points.count] = true
        var stack = [(0, far), (far, points.count)]
        while let (lo, hi) = stack.popLast() {
            guard hi > lo + 1 else { continue }
            var worst = lo, worstDistance = 0.0
            for i in (lo + 1)..<hi {
                let d = distance(closed[i], fromSegment: closed[lo], closed[hi])
                if d > worstDistance { worstDistance = d; worst = i }
            }
            if worstDistance > tolerance {
                keep[worst] = true
                stack.append((lo, worst)); stack.append((worst, hi))
            }
        }
        let result = (0..<points.count).filter { keep[$0] }.map { points[$0] }
        return result.count >= 3 ? result : points
    }

    static func distance(_ p: [Double], fromSegment a: [Double], _ b: [Double]) -> Double {
        let dx = b[0] - a[0], dy = b[1] - a[1]
        let lengthSquared = dx * dx + dy * dy
        guard lengthSquared > 0 else { return hypot(p[0] - a[0], p[1] - a[1]) }
        let t = min(1, max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared))
        return hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
    }

    /// Even-odd point-in-polygon test, plan pixels.
    public static func ring(_ ring: [[Double]], containsX x: Double, y: Double) -> Bool {
        var inside = false
        var j = ring.count - 1
        for i in ring.indices where ring[i].count >= 2 && ring[j].count >= 2 {
            let (xi, yi, xj, yj) = (ring[i][0], ring[i][1], ring[j][0], ring[j][1])
            if (yi > y) != (yj > y), x < (xj - xi) * (y - yi) / (yj - yi) + xi { inside.toggle() }
            j = i
        }
        return inside
    }
}

public extension Building3DModel.FloorModel {
    /// Whether a plan point is on this floor's slab (inside the footprint, not in an opening).
    func contains(x: Double, y: Double) -> Bool {
        guard HoloGeometry.ring(outline, containsX: x, y: y) else { return false }
        return !openings.contains { HoloGeometry.ring($0, containsX: x, y: y) }
    }
}
