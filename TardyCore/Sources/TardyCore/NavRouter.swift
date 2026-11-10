import Foundation

// A* indoor wayfinding over the MapNode / NavEdge graph — a faithful port of the
// C3 branch's `pkgbc231600/src/NavRouter.js`. The parity tests replay that
// router's answers (TardyCoreTests/Fixtures/router-oracle.json) against this one,
// so change the two together or regenerate the fixture deliberately.

// MARK: - Route types

public enum StepKind: String, Sendable {
    case start, straight, turn, connector, arrive
}

public enum TurnDirection: String, Sendable {
    case straight, left, right, around
}

/// One turn-by-turn instruction. `pointIndex` indexes the leg's `points`.
public struct RouteStep: Hashable, Sendable {
    public var kind: StepKind
    public var text: String
    public var meters: Double
    public var seconds: Double
    public var pointIndex: Int
    /// For `.turn` steps, which way; otherwise nil.
    public var turn: TurnDirection?
}

public struct RoutePoint: Hashable, Sendable {
    public var nodeId: String
    public var x: Double
    public var y: Double
    public var kind: NodeKind
}

/// The part of a route on one floor.
public struct RouteLeg: Hashable, Sendable {
    public var floorId: String
    public var floorLevel: Int
    public var floorName: String?
    public var points: [RoutePoint]
    public var seconds: Double
    public var meters: Double
    public var instruction: String
    /// The stairwell / elevator shaft boarded at the end of this leg, if any.
    public var exitConnectorKey: String?
    public var steps: [RouteStep]
}

public struct NavRoute: Hashable, Sendable {
    public var routingRevision: String
    public var found: Bool
    /// Why no route was found, for the student.
    public var message: String?
    public var legs: [RouteLeg]
    public var totalSeconds: Double
    public var totalMeters: Double
    public var floorsTraversed: Int
    public var startNodeId: String?
    public var destNodeId: String?
    public var stepFree: Bool
}

// MARK: - Tuning (see NavRouter.js for the reasoning behind each number)

enum RoutingConstants {
    /// Typical indoor walking pace, meters per second.
    static let walkSpeedMPS = 1.3
    static let defaultPixelsPerMeter = 14.0
    /// Deliberately pessimistic: decides whether a hurried student takes the stairs.
    static let elevatorWaitSeconds = 40.0
    static let elevatorPerFloorSeconds = 10.0
    static let stairUpPerFloorSeconds = 22.0
    static let stairDownPerFloorSeconds = 15.0
    /// The A* heuristic is deflated so hand-authored edge costs can't make it inadmissible.
    static let heuristicSafety = 0.9
    static let searchDefaultLimit = 10
    static let searchMaxLimit = 50
    static let turnMinDegrees = 30.0
    static let turnAroundMinDegrees = 150.0
}

// MARK: - Router

public final class NavRouter: Sendable {
    public let map: BuildingMap
    private let regularGraph: Graph
    private let stepFreeGraph: Graph

    public init(map: BuildingMap) {
        self.map = map
        regularGraph = Graph(map: map, stepFree: false)
        stepFreeGraph = Graph(map: map, stepFree: true)
    }

    // MARK: findRoute

    public func findRoute(from startNodeId: String?, to destNodeId: String?, stepFree: Bool) -> NavRoute {
        guard let startId = nonEmpty(startNodeId), let destId = nonEmpty(destNodeId) else {
            return failed("A start and a destination are both required.", startNodeId, destNodeId, stepFree)
        }
        if startId == destId {
            return failed("You're already there.", startId, destId, stepFree)
        }
        guard map.nodesById[startId] != nil else {
            return failed("Could not find your starting point on the map.", startId, destId, stepFree)
        }

        let graph = stepFree ? stepFreeGraph : regularGraph
        guard graph.nodesById[startId] != nil else {
            return failed(
                stepFree ? "Your starting point is not reachable without stairs."
                         : "Your starting point is not part of the walkable map.",
                startId, destId, stepFree)
        }
        guard let destNode = graph.nodesById[destId] else {
            return failed(
                stepFree ? "That destination has no step-free access in our map."
                         : "That destination is not on the walkable map.",
                startId, destId, stepFree)
        }

        // --- A* ---
        var gScore: [String: Double] = [startId: 0]
        var cameFrom: [String: String] = [:]
        var closed = Set<String>()
        var open = MinHeap()
        open.push(startId, priority: heuristic(graph.nodesById[startId]!, destNode))

        var reached = false
        while let currentId = open.pop() {
            if closed.contains(currentId) { continue }
            if currentId == destId { reached = true; break }
            closed.insert(currentId)

            let currentG = gScore[currentId]!
            for link in graph.adjacency[currentId] ?? [] {
                if closed.contains(link.to) { continue }
                guard let toNode = graph.nodesById[link.to] else { continue }
                let tentative = currentG + link.seconds
                if let known = gScore[link.to], tentative >= known { continue }
                gScore[link.to] = tentative
                cameFrom[link.to] = currentId
                open.push(link.to, priority: tentative + heuristic(toNode, destNode))
            }
        }

        guard reached else {
            return failed(
                stepFree
                    ? "No step-free route to \(destinationLabel(destNode)). The only access we know of involves stairs."
                    : "No walkable route found to \(destinationLabel(destNode)).",
                startId, destId, stepFree)
        }

        var path = [destId]
        var walker = destId
        while let previous = cameFrom[walker] {
            walker = previous
            path.append(walker)
        }
        path.reverse()

        let assembled = assembleLegs(path: path, graph: graph, destNode: destNode)
        return NavRoute(
            routingRevision: BuildingMap.graingerRoutingRevision,
            found: true,
            message: nil,
            legs: assembled.legs,
            totalSeconds: roundTenth(assembled.totalSeconds),
            totalMeters: roundTenth(assembled.totalMeters),
            floorsTraversed: Set(assembled.legs.map(\.floorId)).count,
            startNodeId: startId,
            destNodeId: destId,
            stepFree: stepFree)
    }

    // MARK: searchRooms

    /// Rank nodes whose number, name or aliases match `query`. A typed room
    /// number beats a name that merely contains it.
    public func searchRooms(_ query: String, limit: Int? = nil) -> [MapNode] {
        let capped = (limit ?? 0) > 0 ? min(limit!, RoutingConstants.searchMaxLimit) : RoutingConstants.searchDefaultLimit
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return [] }

        var scored: [(node: MapNode, score: Int, index: Int)] = []
        for (index, n) in map.nodes.enumerated() {
            let roomNumber = (n.roomNumber ?? "").lowercased()
            let name = (n.name ?? "").lowercased()
            let aliases = (n.searchAliases ?? "").lowercased()
            let score: Int
            if !roomNumber.isEmpty && roomNumber == needle { score = 0 }
            else if !roomNumber.isEmpty && roomNumber.hasPrefix(needle) { score = 1 }
            else if !name.isEmpty && name.hasPrefix(needle) { score = 2 }
            else if !name.isEmpty && name.range(of: needle) != nil { score = 3 }
            else if !aliases.isEmpty && aliases.range(of: needle) != nil { score = 4 }
            else if !roomNumber.isEmpty && roomNumber.range(of: needle) != nil { score = 5 }
            else { continue }
            scored.append((n, score, index))
        }
        scored.sort { x, y in
            if x.score != y.score { return x.score < y.score }
            let xr = x.node.roomNumber ?? "", yr = y.node.roomNumber ?? ""
            if xr != yr { return xr < yr }
            return x.index < y.index // keep JS's stable-sort order
        }
        return scored.prefix(capped).map(\.node)
    }

    // MARK: nearestNode

    /// The node on `floorId` closest to a plan pixel position.
    public func nearestNode(floorId: String, x: Double, y: Double, where include: (MapNode) -> Bool = { _ in true }) -> MapNode? {
        var best: MapNode?
        var bestDistance = Double.greatestFiniteMagnitude
        for node in map.nodes where node.floorId == floorId && include(node) {
            let dx = node.imageX - x, dy = node.imageY - y
            let d = dx * dx + dy * dy
            if d < bestDistance {
                bestDistance = d
                best = node
            }
        }
        return best
    }

    // MARK: - Internals

    private func failed(_ message: String, _ start: String?, _ dest: String?, _ stepFree: Bool) -> NavRoute {
        NavRoute(routingRevision: BuildingMap.graingerRoutingRevision, found: false, message: message, legs: [],
                 totalSeconds: 0, totalMeters: 0, floorsTraversed: 0,
                 startNodeId: nonEmpty(start), destNodeId: nonEmpty(dest), stepFree: stepFree)
    }

    private func floor(_ node: MapNode) -> Floor? { map.floorsById[node.floorId] }

    private func pixelsPerMeter(_ node: MapNode) -> Double {
        if let ppm = floor(node)?.pixelsPerMeter, ppm != 0 { return ppm }
        return RoutingConstants.defaultPixelsPerMeter
    }

    /// Admissible time-to-go: deflated straight-line walk on a floor, plus the
    /// cheapest conceivable vertical move (an elevator with no wait) across floors.
    private func heuristic(_ a: MapNode, _ b: MapNode) -> Double {
        let fa = floor(a), fb = floor(b)
        let sameFloor = fa != nil && fb != nil && a.floorId == b.floorId
        var horizontal = 0.0
        if sameFloor {
            let dx = a.imageX - b.imageX, dy = a.imageY - b.imageY
            let meters = (dx * dx + dy * dy).squareRoot() / pixelsPerMeter(a)
            horizontal = (meters / RoutingConstants.walkSpeedMPS) * RoutingConstants.heuristicSafety
        }
        var vertical = 0.0
        if !sameFloor, let fa, let fb {
            let floors = Double(abs(fb.level - fa.level))
            vertical = RoutingConstants.elevatorPerFloorSeconds * floors * RoutingConstants.heuristicSafety
        }
        return horizontal + vertical
    }

    private func assembleLegs(path: [String], graph: Graph, destNode: MapNode)
        -> (legs: [RouteLeg], totalSeconds: Double, totalMeters: Double) {
        var legs: [RouteLeg] = []
        var legHops: [[Hop]] = []
        var current: RouteLeg?
        var currentHops: [Hop] = []
        var totalSeconds = 0.0
        var totalMeters = 0.0

        for i in path.indices {
            let node = graph.nodesById[path[i]]!
            let nodeFloor = floor(node)
            let floorId = nodeFloor?.id ?? "unknown"

            if current == nil || current!.floorId != floorId {
                if let finished = current {
                    legs.append(finished)
                    legHops.append(currentHops)
                }
                currentHops = []
                current = RouteLeg(floorId: floorId, floorLevel: nodeFloor?.level ?? 0, floorName: nodeFloor?.name,
                                   points: [], seconds: 0, meters: 0, instruction: "", exitConnectorKey: nil, steps: [])
            }
            current!.points.append(RoutePoint(nodeId: node.id, x: node.imageX, y: node.imageY, kind: node.kind))

            // Attribute the cost of the hop leaving this node.
            guard i < path.count - 1 else { continue }
            var chosen: Link?
            for link in graph.adjacency[path[i]] ?? [] where link.to == path[i + 1] {
                if chosen == nil || link.seconds < chosen!.seconds { chosen = link }
            }
            guard let chosen else { continue }
            totalSeconds += chosen.seconds
            if let shaft = chosen.viaConnector {
                current!.exitConnectorKey = shaft // vertical hop: ends this leg
            } else {
                current!.seconds += chosen.seconds
                current!.meters += chosen.meters
                totalMeters += chosen.meters
                let next = graph.nodesById[path[i + 1]]!
                if (floor(next)?.id ?? "unknown") == floorId {
                    let fromIndex = current!.points.count - 1
                    currentHops.append(Hop(fromIndex: fromIndex, toIndex: fromIndex + 1,
                                           meters: chosen.meters, seconds: chosen.seconds))
                }
            }
        }
        if let finished = current {
            legs.append(finished)
            legHops.append(currentHops)
        }

        let destText = destinationLabel(destNode)
        for i in legs.indices {
            let leg = legs[i]
            let arrivingVia = i > 0 ? legs[i - 1].exitConnectorKey : nil
            let boardNode = leg.exitConnectorKey != nil ? graph.nodesById[leg.points.last!.nodeId] : nil
            let floorText = nonEmpty(leg.floorName) ?? "Level \(leg.floorLevel)"

            if arrivingVia != nil {
                let vehicle = connectorLabel(graph.nodesById[leg.points[0].nodeId]!)
                let prefix = "Take \(vehicle) to \(floorText)"
                legs[i].instruction = boardNode != nil
                    ? "\(prefix), then walk to \(connectorLabel(boardNode!))"
                    : "\(prefix), then walk to \(destText)"
            } else if let boardNode {
                legs[i].instruction = "Walk to \(connectorLabel(boardNode))"
            } else {
                legs[i].instruction = "Walk to \(destText)"
            }

            let arrivedFrom = arrivingVia != nil ? graph.nodesById[legs[i - 1].points.last!.nodeId] : nil
            let isLast = i == legs.count - 1
            legs[i].steps = buildSteps(leg: legs[i], hops: legHops[i], graph: graph,
                                       arrivedFrom: arrivedFrom, destNode: isLast ? destNode : nil)
        }
        return (legs, totalSeconds, totalMeters)
    }

    /// Turn-by-turn steps for one leg. Collinear hops merge; the final hop into
    /// the destination becomes the arrive step when it bends left or right.
    private func buildSteps(leg: RouteLeg, hops: [Hop], graph: Graph, arrivedFrom: MapNode?, destNode: MapNode?) -> [RouteStep] {
        struct Draft {
            var kind: StepKind
            var text = ""
            var meters = 0.0
            var seconds = 0.0
            var pointIndex: Int
            var turn: TurnDirection?
            var endIndex: Int
        }
        struct Doorway { var side: TurnDirection; var fromIndex: Int; var meters: Double; var seconds: Double }

        let lastIndex = leg.points.count - 1
        var steps: [Draft] = []
        var walk: Int? // index into steps of the step accumulating hops
        var heading: (dx: Double, dy: Double)?
        var doorway: Doorway?
        func nodeAt(_ index: Int) -> MapNode { graph.nodesById[leg.points[index].nodeId]! }
        let floorText = nonEmpty(leg.floorName) ?? "Level \(leg.floorLevel)"

        if let arrivedFrom {
            let upOrDown = leg.floorLevel > (floor(arrivedFrom)?.level ?? 0) ? "up" : "down"
            steps.append(Draft(kind: .connector, text: "Take \(connectorLabel(nodeAt(0))) \(upOrDown) to \(floorText)",
                               pointIndex: 0, endIndex: 0))
        }

        func openWalk(_ kind: StepKind, _ turn: TurnDirection?, _ fromIndex: Int) {
            steps.append(Draft(kind: kind, pointIndex: fromIndex, turn: turn, endIndex: fromIndex))
            walk = steps.count - 1
        }

        for (i, hop) in hops.enumerated() {
            let from = leg.points[hop.fromIndex], to = leg.points[hop.toIndex]
            let h = (dx: to.x - from.x, dy: to.y - from.y)
            let zeroLength = h.dx == 0 && h.dy == 0
            let dir: TurnDirection = (zeroLength || heading == nil) ? .straight : turnDirection(heading!, h)
            let isDoorway = destNode != nil && i == hops.count - 1 && to.nodeId == destNode!.id

            if isDoorway && walk != nil && (dir == .left || dir == .right) {
                doorway = Doorway(side: dir, fromIndex: hop.fromIndex, meters: hop.meters, seconds: hop.seconds)
                continue
            }
            if walk == nil {
                openWalk(arrivedFrom != nil ? .straight : .start, nil, hop.fromIndex)
            } else if dir != .straight {
                openWalk(.turn, dir, hop.fromIndex)
            }
            steps[walk!].meters += hop.meters
            steps[walk!].seconds += hop.seconds
            steps[walk!].endIndex = hop.toIndex
            if !zeroLength { heading = h }
        }

        // A first leg that never walks (the start is a connector) still says where to start.
        if arrivedFrom == nil && steps.isEmpty { openWalk(.start, nil, 0) }

        let boardLabel = leg.exitConnectorKey != nil ? connectorLabel(nodeAt(lastIndex)) : nil
        let doorLandmark = doorway.flatMap { landmarkLabel(nodeAt($0.fromIndex)) }
        for i in steps.indices where steps[i].kind != .connector {
            let step = steps[i]
            var walkText = step.meters > 0 ? "walk \(metersText(step.meters))" : ""
            if !walkText.isEmpty, let boardLabel, step.endIndex == lastIndex {
                walkText += " to \(boardLabel)"
            } else if !walkText.isEmpty, let doorLandmark, let doorway, step.endIndex == doorway.fromIndex {
                walkText += " to \(doorLandmark)"
            }

            switch step.kind {
            case .start:
                let startNode = nodeAt(step.pointIndex)
                let startLabel = nonEmpty(startNode.name) ?? nonEmpty(startNode.roomNumber)
                if walkText.isEmpty {
                    steps[i].text = "Start at \(startLabel ?? "your starting point")"
                } else {
                    steps[i].text = startLabel != nil ? "From \(startLabel!), \(walkText)" : capitalize(walkText)
                }
            case .straight:
                steps[i].text = capitalize(walkText.isEmpty ? "continue straight" : walkText)
            default:
                let landmark = landmarkLabel(nodeAt(step.pointIndex))
                steps[i].text = "Turn \(step.turn?.rawValue ?? "")"
                    + (landmark.map { " at \($0)" } ?? "")
                    + (walkText.isEmpty ? "" : ", then \(walkText)")
            }
        }

        if let destNode {
            let destText = destinationLabel(destNode)
            var arrive = Draft(kind: .arrive, pointIndex: lastIndex, endIndex: lastIndex)
            if destNode.labelX != nil {
                arrive.text = "You have reached the mapped access point for \(destText)"
            } else if let doorway {
                arrive.text = "\(destText) is on your \(doorway.side.rawValue)" + (doorLandmark.map { " at \($0)" } ?? "")
                arrive.meters = doorway.meters
                arrive.seconds = doorway.seconds
                arrive.pointIndex = doorway.fromIndex
            } else if hops.isEmpty {
                arrive.text = "You have arrived at \(destText)"
            } else {
                arrive.text = "\(destText) is straight ahead"
            }
            steps.append(arrive)
        }

        return steps.map {
            RouteStep(kind: $0.kind, text: $0.text, meters: roundTenth($0.meters), seconds: roundTenth($0.seconds),
                      pointIndex: $0.pointIndex, turn: $0.kind == .turn ? $0.turn : nil)
        }
    }
}

// MARK: - Graph

private struct Link: Sendable {
    var to: String
    var seconds: Double
    var meters: Double
    var viaConnector: String?
}

private struct Hop {
    var fromIndex: Int
    var toIndex: Int
    var meters: Double
    var seconds: Double
}

/// Adjacency for one routing mode. Cross-floor links are synthesized from
/// shared `connectorKey`s, never stored, so adding a floor stays a local change.
private struct Graph: Sendable {
    var nodesById: [String: MapNode] = [:]
    var adjacency: [String: [Link]] = [:]

    init(map: BuildingMap, stepFree: Bool) {
        for node in map.nodes {
            // In step-free mode a stairwell node is not a place a wheelchair user can be.
            if stepFree && node.stepFree == false { continue }
            nodesById[node.id] = node
        }
        for edge in map.edges {
            if stepFree && edge.stepFree == false { continue }
            guard nodesById[edge.fromNodeId] != nil, nodesById[edge.toNodeId] != nil else { continue }
            adjacency[edge.fromNodeId, default: []].append(
                Link(to: edge.toNodeId, seconds: edge.seconds, meters: edge.meters ?? 0, viaConnector: nil))
        }

        // Group connectors by key, keeping first-seen key order (as JS object keys do).
        var keyOrder: [String] = []
        var groups: [String: [MapNode]] = [:]
        for node in map.nodes {
            guard let key = nonEmpty(node.connectorKey), nodesById[node.id] != nil else { continue }
            if groups[key] == nil { keyOrder.append(key) }
            groups[key, default: []].append(node)
        }
        for key in keyOrder {
            let group = groups[key]!
            for a in group.indices {
                for b in group.indices where a != b {
                    guard let cost = connectorCost(group[a], group[b], stepFree: stepFree, map: map) else { continue }
                    adjacency[group[a].id, default: []].append(Link(to: group[b].id, seconds: cost, meters: 0, viaConnector: key))
                }
            }
        }
    }
}

/// Seconds to ride a connector between floors; nil when the move isn't allowed.
private func connectorCost(_ from: MapNode, _ to: MapNode, stepFree: Bool, map: BuildingMap) -> Double? {
    guard let fromLevel = map.floorsById[from.floorId]?.level,
          let toLevel = map.floorsById[to.floorId]?.level else { return nil }
    let delta = toLevel - fromLevel
    if delta == 0 { return nil }
    let floors = Double(abs(delta))
    switch from.kind {
    case .elevator:
        return RoutingConstants.elevatorWaitSeconds + RoutingConstants.elevatorPerFloorSeconds * floors
    case .stairs:
        if stepFree { return nil }
        let perFloor = delta > 0 ? RoutingConstants.stairUpPerFloorSeconds : RoutingConstants.stairDownPerFloorSeconds
        return perFloor * floors
    default:
        return nil
    }
}

// MARK: - Binary min-heap (same algorithm as the JS router, so ties pop in the same order)

private struct MinHeap {
    private var items: [(key: String, priority: Double)] = []

    mutating func push(_ key: String, priority: Double) {
        items.append((key, priority))
        var i = items.count - 1
        while i > 0 {
            let parent = (i - 1) >> 1
            if items[parent].priority <= items[i].priority { break }
            items.swapAt(parent, i)
            i = parent
        }
    }

    mutating func pop() -> String? {
        guard !items.isEmpty else { return nil }
        let top = items[0]
        let last = items.removeLast()
        if !items.isEmpty {
            items[0] = last
            var i = 0
            let n = items.count
            while true {
                let left = 2 * i + 1, right = left + 1
                var smallest = i
                if left < n && items[left].priority < items[smallest].priority { smallest = left }
                if right < n && items[right].priority < items[smallest].priority { smallest = right }
                if smallest == i { break }
                items.swapAt(smallest, i)
                i = smallest
            }
        }
        return top.key
    }
}

// MARK: - Phrasing helpers

/// Classify the change of heading. Image y grows downward, so a positive cross
/// product is a clockwise (right) turn on screen.
func turnDirection(_ h1: (dx: Double, dy: Double), _ h2: (dx: Double, dy: Double)) -> TurnDirection {
    let cross = h1.dx * h2.dy - h1.dy * h2.dx
    let dot = h1.dx * h2.dx + h1.dy * h2.dy
    let degrees = atan2(abs(cross), dot) * 180 / Double.pi
    if degrees < RoutingConstants.turnMinDegrees { return .straight }
    if degrees > RoutingConstants.turnAroundMinDegrees { return .around }
    return cross > 0 ? .right : .left
}

/// Friendly label for a vertical connector, preferring its authored name.
public func connectorLabel(_ node: MapNode) -> String {
    nonEmpty(node.name) ?? nonEmpty(node.connectorKey) ?? (node.kind == .elevator ? "the elevator" : "the stairs")
}

/// "3335 (Learning Commons)", "3335", "Restrooms" or "your destination".
public func destinationLabel(_ node: MapNode) -> String {
    if let number = nonEmpty(node.roomNumber), let name = nonEmpty(node.name) { return "\(number) (\(name))" }
    return nonEmpty(node.roomNumber) ?? nonEmpty(node.name) ?? "your destination"
}

/// A node worth naming at a turn: a numbered room or a stair/elevator.
func landmarkLabel(_ node: MapNode) -> String? {
    if let number = nonEmpty(node.roomNumber) { return number }
    if nonEmpty(node.connectorKey) != nil || node.kind == .elevator || node.kind == .stairs { return connectorLabel(node) }
    return nil
}

func metersText(_ meters: Double) -> String { "\(max(1, Int(jsRound(meters)))) m" }

/// JavaScript's Math.round: halves round toward +∞.
func jsRound(_ x: Double) -> Double {
    let f = x.rounded(.down)
    return x - f >= 0.5 ? f + 1 : f
}

/// One decimal place, matching how the JS router rounds totals.
func roundTenth(_ x: Double) -> Double { jsRound(x * 10) / 10 }

func capitalize(_ text: String) -> String { text.prefix(1).uppercased() + text.dropFirst() }
