import Foundation
import XCTest
@testable import TardyCore

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
