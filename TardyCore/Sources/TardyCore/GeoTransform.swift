import Foundation

/// A point in a floor plan's pixel space (x right, y down).
public struct PlanPoint: Hashable, Sendable {
    public var x: Double
    public var y: Double
    public init(x: Double, y: Double) { self.x = x; self.y = y }
}

/// Fits a lat/lon → plan-pixel mapping from a floor's calibration points.
///
/// The result is only a *suggestion* for the "I'm here" pin: indoor GPS is good
/// to 5–15 m horizontally and can't tell floors apart at all (vertical error of
/// 15–40 m against ~4 m floor spacing), so the student always picks the floor
/// and can move the pin.
///
/// Differs from the C3 web version on purpose: positions are projected into a
/// local *east/south* frame before fitting, so they share the plan's y-down
/// orientation. The web version fitted against east/north, which a
/// two-point similarity (rotation + uniform scale) can't un-mirror, so its
/// suggestions came out reflected across the calibration diagonal.
public struct GeoTransform: Sendable {
    public enum Kind: String, Sendable { case affine, similarity }

    public let kind: Kind
    /// Plan pixels per real-world meter implied by the fit.
    public let pixelsPerMeter: Double
    private let lat0: Double
    private let lon0: Double
    // x = ax·east + bx·south + cx ; y = ay·east + by·south + cy
    private let ax, bx, cx, ay, by, cy: Double

    public init?(points: [CalibrationPoint]) {
        guard points.count >= 2 else { return nil }
        let lat0 = points.map(\.lat).reduce(0, +) / Double(points.count)
        let lon0 = points.map(\.lon).reduce(0, +) / Double(points.count)
        let local = points.map { GeoTransform.localMeters(lat: $0.lat, lon: $0.lon, lat0: lat0, lon0: lon0) }

        if points.count >= 3, let fit = GeoTransform.fitAffine(points, local) {
            self.init(kind: .affine, coefficients: fit, lat0: lat0, lon0: lon0)
            return
        }
        let (i, j) = points.count >= 3 ? (0, points.count - 1) : (0, 1)
        guard let fit = GeoTransform.fitSimilarity(points[i], local[i], points[j], local[j]) else { return nil }
        self.init(kind: .similarity, coefficients: fit, lat0: lat0, lon0: lon0)
    }

    private init(kind: Kind, coefficients c: [Double], lat0: Double, lon0: Double) {
        self.kind = kind
        (ax, bx, cx, ay, by, cy) = (c[0], c[1], c[2], c[3], c[4], c[5])
        self.lat0 = lat0
        self.lon0 = lon0
        let scaleEast = (ax * ax + ay * ay).squareRoot()
        let scaleSouth = (bx * bx + by * by).squareRoot()
        pixelsPerMeter = (scaleEast + scaleSouth) / 2
    }

    public func project(lat: Double, lon: Double) -> PlanPoint {
        let p = GeoTransform.localMeters(lat: lat, lon: lon, lat0: lat0, lon0: lon0)
        return PlanPoint(x: ax * p.east + bx * p.south + cx, y: ay * p.east + by * p.south + cy)
    }

    // MARK: Fitting

    private static let earthRadius = 6_378_137.0

    private static func localMeters(lat: Double, lon: Double, lat0: Double, lon0: Double) -> (east: Double, south: Double) {
        let east = (lon - lon0) * .pi / 180 * earthRadius * cos(lat0 * .pi / 180)
        let north = (lat - lat0) * .pi / 180 * earthRadius
        return (east, -north)
    }

    private static func fitSimilarity(_ p0: CalibrationPoint, _ a: (east: Double, south: Double),
                                      _ p1: CalibrationPoint, _ b: (east: Double, south: Double)) -> [Double]? {
        let wx = b.east - a.east, wy = b.south - a.south
        let lenSq = wx * wx + wy * wy
        guard lenSq > 1e-6 else { return nil }
        let px = p1.imageX - p0.imageX, py = p1.imageY - p0.imageY
        // Complex division (pixel vector)/(world vector) = scale·e^{iθ}.
        let k = (px * wx + py * wy) / lenSq
        let s = (py * wx - px * wy) / lenSq
        guard (k * k + s * s).squareRoot() > 1e-9 else { return nil }
        // x = x0 + k(e - e0) - s(n - n0);  y = y0 + s(e - e0) + k(n - n0)
        return [k, -s, p0.imageX - k * a.east + s * a.south,
                s, k, p0.imageY - s * a.east - k * a.south]
    }

    private static func fitAffine(_ points: [CalibrationPoint], _ local: [(east: Double, south: Double)]) -> [Double]? {
        var ata = [[Double]](repeating: [0, 0, 0], count: 3)
        var atx = [0.0, 0, 0], aty = [0.0, 0, 0]
        for (i, p) in points.enumerated() {
            let row = [local[i].east, local[i].south, 1]
            for r in 0..<3 {
                for c in 0..<3 { ata[r][c] += row[r] * row[c] }
                atx[r] += row[r] * p.imageX
                aty[r] += row[r] * p.imageY
            }
        }
        guard let cx = solve(ata, atx), let cy = solve(ata, aty) else { return nil }
        return cx + cy
    }

    /// Gauss–Jordan with partial pivoting; nil when singular (e.g. collinear points).
    private static func solve(_ a: [[Double]], _ b: [Double]) -> [Double]? {
        let n = b.count
        var m = a.enumerated().map { $0.element + [b[$0.offset]] }
        for col in 0..<n {
            var pivot = col
            for row in (col + 1)..<n where abs(m[row][col]) > abs(m[pivot][col]) { pivot = row }
            guard abs(m[pivot][col]) >= 1e-12 else { return nil }
            m.swapAt(col, pivot)
            for row in 0..<n where row != col {
                let factor = m[row][col] / m[col][col]
                for k in col...n { m[row][k] -= factor * m[col][k] }
            }
        }
        return (0..<n).map { m[$0][n] / m[$0][$0] }
    }
}
