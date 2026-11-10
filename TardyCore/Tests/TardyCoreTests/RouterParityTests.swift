import Foundation
import XCTest
@testable import TardyCore

/// Replays answers recorded from the original C3 JavaScript router
/// (`Fixtures/router-oracle.json`, made by `scripts/make_router_oracle.js`)
/// and requires the Swift port to give the same routes, words and numbers.
final class RouterParityTests: XCTestCase {
    struct Oracle: Decodable {
        struct Step: Decodable { var kind: String; var text: String; var meters: Double; var seconds: Double; var pointIndex: Int }
        struct Leg: Decodable {
            var floorId: String; var floorLevel: Int; var instruction: String; var exitConnectorKey: String?
            var seconds: Double; var meters: Double; var nodeIds: [String]; var steps: [Step]
        }
        struct Route: Decodable {
            var found: Bool; var message: String?; var totalSeconds: Double; var totalMeters: Double
            var floorsTraversed: Int; var legs: [Leg]
        }
        struct Case: Decodable { var start: String; var dest: String; var stepFree: Bool; var route: Route }
        struct Search: Decodable { var query: String; var ids: [String] }
        struct Nearest: Decodable { var floorId: String; var x: Double; var y: Double; var id: String }
        var routes: [Case]
        var searches: [Search]
        var nearest: [Nearest]
    }

    static let map = try! BuildingMap.loadGrainger()
    static let router = NavRouter(map: map)
    static let oracle: Oracle = {
        let url = Bundle.module.url(forResource: "Fixtures", withExtension: nil)!
            .appendingPathComponent("router-oracle.json")
        return try! JSONDecoder().decode(Oracle.self, from: Data(contentsOf: url))
    }()

    func testMapLoads() {
        let map = Self.map
        XCTAssertEqual(map.building.name, "Grainger Hall")
        XCTAssertEqual(map.floors.map(\.level), [1, 2, 3])
        XCTAssertEqual(map.nodes.count, 674)
        XCTAssertEqual(map.edges.count, 1356)
        XCTAssertEqual(map.places.count, 265)
        XCTAssertEqual(map.defaultStart?.id, "n-f1-entrance-w")
        XCTAssertEqual(map.floors.compactMap(\.planImageName), ["floor_p1", "floor_p2", "floor_p3"])
    }

    func testRoutesMatchTheJavaScriptRouter() {
        XCTAssertGreaterThan(Self.oracle.routes.count, 800)
        var mismatches = 0
        for c in Self.oracle.routes {
            let got = Self.router.findRoute(from: c.start, to: c.dest, stepFree: c.stepFree)
            let label = "\(c.start) → \(c.dest) stepFree=\(c.stepFree)"
            let before = mismatches
            func check(_ ok: Bool, _ what: @autoclosure () -> String) {
                if !ok { mismatches += 1; if mismatches < 15 { XCTFail("\(label): \(what())") } }
            }
            check(got.found == c.route.found, "found \(got.found) vs \(c.route.found)")
            check(got.message == c.route.message, "message \(got.message ?? "nil") vs \(c.route.message ?? "nil")")
            check(got.totalSeconds == c.route.totalSeconds, "seconds \(got.totalSeconds) vs \(c.route.totalSeconds)")
            check(got.totalMeters == c.route.totalMeters, "meters \(got.totalMeters) vs \(c.route.totalMeters)")
            check(got.floorsTraversed == c.route.floorsTraversed, "floors")
            check(got.legs.count == c.route.legs.count, "leg count \(got.legs.count) vs \(c.route.legs.count)")
            guard mismatches == before else { continue }
            for (g, e) in zip(got.legs, c.route.legs) {
                check(g.floorId == e.floorId && g.floorLevel == e.floorLevel, "leg floor")
                check(g.points.map(\.nodeId) == e.nodeIds, "path differs on \(e.floorId)")
                check(g.instruction == e.instruction, "instruction '\(g.instruction)' vs '\(e.instruction)'")
                check(g.exitConnectorKey == e.exitConnectorKey, "exit connector")
                check(abs(g.seconds - e.seconds) < 0.001 && abs(g.meters - e.meters) < 0.001, "leg totals")
                check(g.steps.count == e.steps.count, "step count on \(e.floorId)")
                for (gs, es) in zip(g.steps, e.steps) {
                    check(gs.kind.rawValue == es.kind && gs.text == es.text, "step '\(gs.text)' vs '\(es.text)'")
                    check(gs.meters == es.meters && gs.seconds == es.seconds && gs.pointIndex == es.pointIndex,
                          "step numbers for '\(es.text)'")
                }
            }
        }
        XCTAssertEqual(mismatches, 0, "routes differing from the JS router")
    }

    func testSearchMatchesTheJavaScriptRouter() {
        for s in Self.oracle.searches {
            XCTAssertEqual(Self.router.searchRooms(s.query, limit: 10).map(\.id), s.ids, "query '\(s.query)'")
        }
    }

    func testNearestNodeMatchesTheJavaScriptRouter() {
        for n in Self.oracle.nearest {
            XCTAssertEqual(Self.router.nearestNode(floorId: n.floorId, x: n.x, y: n.y)?.id, n.id)
        }
    }

    func testStepFreeRouteAvoidsStairs() {
        let route = Self.router.findRoute(from: "n-f1-entrance-w", to: "n-f3-r3335", stepFree: true)
        XCTAssertTrue(route.found)
        XCTAssertFalse(route.legs.flatMap(\.points).contains { $0.kind == .stairs })
        XCTAssertGreaterThan(route.floorsTraversed, 1)
    }
}
