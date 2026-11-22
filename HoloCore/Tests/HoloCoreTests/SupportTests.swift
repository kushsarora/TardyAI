import Foundation
import XCTest
@testable import HoloCore

final class ArrivalTests: XCTestCase {
    private var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/Chicago")!
        return c
    }

    private func at(_ hour: Int, _ minute: Int, _ second: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 10, day: 19, hour: hour, minute: minute, second: second))!
    }

    // Ported from the C3 web app's ArrivalCard tests.
    func testLateByLessThanAMinuteIsStillLate() {
        let v = ArrivalEstimator.verdict(now: at(10, 0), classHour: 10, classMinute: 0, routeSeconds: 30, calendar: calendar)!
        XCTAssertTrue(v.isLate)
        XCTAssertEqual(v.headline, "About 1 min late")
    }

    func testVerdictChangesAsTimePasses() {
        let early = ArrivalEstimator.verdict(now: at(10, 0), classHour: 10, classMinute: 2, routeSeconds: 60, calendar: calendar)!
        XCTAssertEqual(early.headline, "1 min to spare")
        let later = ArrivalEstimator.verdict(now: at(10, 1, 30), classHour: 10, classMinute: 2, routeSeconds: 60, calendar: calendar)!
        XCTAssertEqual(later.headline, "About 1 min late")
    }

    func testJustInTime() {
        let v = ArrivalEstimator.verdict(now: at(9, 58, 30), classHour: 10, classMinute: 0, routeSeconds: 60, calendar: calendar)!
        XCTAssertFalse(v.isLate)
        XCTAssertEqual(v.headline, "You’ll arrive just in time")
    }

    func testDurationText() {
        XCTAssertEqual(ArrivalEstimator.durationText(seconds: 42), "42 sec")
        XCTAssertEqual(ArrivalEstimator.durationText(seconds: 61), "2 min")
        XCTAssertEqual(ArrivalEstimator.durationText(seconds: 180), "3 min")
    }
}

final class GeoTransformTests: XCTestCase {
    let floor = try! BuildingMap.loadGrainger().floors[0]

    func testCalibrationPointsMapOntoThemselves() throws {
        let fit = try XCTUnwrap(GeoTransform(points: floor.calibration))
        for p in floor.calibration {
            let got = fit.project(lat: p.lat, lon: p.lon)
            XCTAssertEqual(got.x, p.imageX, accuracy: 0.01)
            XCTAssertEqual(got.y, p.imageY, accuracy: 0.01)
        }
    }

    /// North is up on the plan: a point due north of the building's south-east
    /// corner must land above it, not mirrored off to the side.
    func testPlanIsNotMirrored() throws {
        let fit = try XCTUnwrap(GeoTransform(points: floor.calibration))
        let nw = floor.calibration[0], se = floor.calibration[1]
        let ne = fit.project(lat: nw.lat, lon: se.lon)
        let sw = fit.project(lat: se.lat, lon: nw.lon)
        XCTAssertGreaterThan(ne.x, sw.x, "east should be to the right")
        XCTAssertLessThan(ne.y, sw.y, "north should be up")
    }

    func testAffineWithThreePoints() throws {
        let pts = [
            CalibrationPoint(lat: 43.0730, lon: -89.4020, imageX: 100, imageY: 100),
            CalibrationPoint(lat: 43.0730, lon: -89.4000, imageX: 1700, imageY: 100),
            CalibrationPoint(lat: 43.0720, lon: -89.4020, imageX: 100, imageY: 1400),
        ]
        let fit = try XCTUnwrap(GeoTransform(points: pts))
        XCTAssertEqual(fit.kind, .affine)
        let p = fit.project(lat: 43.0720, lon: -89.4000)
        XCTAssertEqual(p.x, 1700, accuracy: 0.5)
        XCTAssertEqual(p.y, 1400, accuracy: 0.5)
    }

    func testTooFewPoints() {
        XCTAssertNil(GeoTransform(points: Array(floor.calibration.prefix(1))))
    }
}

final class Building3DModelTests: XCTestCase {
    func testModelMatchesTheMappedFloors() throws {
        let model = try Building3DModel.loadGrainger()
        let map = try BuildingMap.loadGrainger()
        XCTAssertEqual(Set(model.floors.map(\.floorId)), Set(map.floors.map(\.id)))
        for f in model.floors {
            XCTAssertGreaterThan(f.outline.count, 3)
            XCTAssertFalse(f.walls.isEmpty)
            XCTAssertTrue(f.walls.allSatisfy { $0.outline.allSatisfy { $0.count == 2 } })
        }
    }

    func testWorldMappingCentersThePlan() {
        let floor = try! BuildingMap.loadGrainger().floors[2]
        let center = World3D.point(x: floor.imageWidth / 2, y: floor.imageHeight / 2, floor: floor, floorGap: 26)
        XCTAssertEqual(center.x, 0)
        XCTAssertEqual(center.z, 0)
        XCTAssertEqual(center.y, 52)
    }
}

final class WallMeshTests: XCTestCase {
    func testSimplifyKeepsCornersAndDropsStairSteps() {
        // A 100×100 square whose top edge is traced in 2-px stair steps of 1 px.
        var ring: [[Double]] = [[0, 0]]
        for x in stride(from: 2.0, through: 98, by: 2) { ring.append([x, x.truncatingRemainder(dividingBy: 4) == 0 ? 0 : 1]) }
        ring += [[100, 0], [100, 100], [0, 100]]
        let simple = HoloGeometry.simplify(ring: ring, tolerance: 1.5)
        XCTAssertEqual(simple.count, 4)
        XCTAssertEqual(Set(simple.map { "\($0[0]),\($0[1])" }), ["0.0,0.0", "100.0,0.0", "100.0,100.0", "0.0,100.0"])
    }

    func testBandHasTwoTrianglesAndOneTopLinePerEdge() {
        var mesh = WallMesh()
        mesh.addBand(ring: [SIMD3(0, 0, 0), SIMD3(1, 0, 0), SIMD3(1, 0, 1)], height: 2)
        XCTAssertEqual(mesh.positions.count, 6)
        XCTAssertEqual(mesh.triangles.count, 18)
        XCTAssertEqual(mesh.topLines.count, 6)
        XCTAssertTrue(mesh.triangles.allSatisfy { $0 < 6 })
        XCTAssertTrue(mesh.topLines.allSatisfy { mesh.positions[Int($0)].y == 2 })
    }

    func testGraingerWallMeshesAreSmallAndValid() throws {
        let model = try Building3DModel.loadGrainger()
        let map = try BuildingMap.loadGrainger()
        for authored in model.floors {
            let floor = try XCTUnwrap(map.floorsById[authored.floorId])
            let mesh = HoloGeometry.wallMesh(for: authored, floor: floor, height: model.wallHeightMeters)
            XCTAssertFalse(mesh.isEmpty)
            XCTAssertLessThan(mesh.positions.count, 20_000, "level \(authored.level)")
            XCTAssertTrue(mesh.triangles.allSatisfy { Int($0) < mesh.positions.count })
            XCTAssertTrue(mesh.positions.allSatisfy { $0.x.isFinite && $0.y.isFinite && $0.z.isFinite })
            XCTAssertTrue(mesh.positions.allSatisfy { abs($0.x) < 90 && abs($0.z) < 70 })
            XCTAssertFalse(HoloGeometry.rimMesh(for: authored, floor: floor, height: 1).isEmpty)
            print("level \(authored.level): \(mesh.positions.count) vertices, \(mesh.triangles.count / 3) triangles")
        }
    }

    func testFootprintContainsRoomsButNotTheMargin() throws {
        let model = try Building3DModel.loadGrainger()
        let map = try BuildingMap.loadGrainger()
        for authored in model.floors {
            XCTAssertFalse(authored.contains(x: 5, y: 5))
            let rooms = map.nodes.filter { $0.floorId == authored.floorId && $0.kind == .room }
            let inside = rooms.filter { authored.contains(x: $0.imageX, y: $0.imageY) }
            XCTAssertGreaterThan(Double(inside.count), Double(rooms.count) * 0.9, "level \(authored.level)")
        }
    }
}
