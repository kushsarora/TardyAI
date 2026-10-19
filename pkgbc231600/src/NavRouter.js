/*
 * Server-side implementation of NavRouter: A* indoor wayfinding over the
 * MapNode / NavEdge graph. See NavRouter.c3typ for the API contract and the
 * routing model; this file carries only implementation notes.
 */

/** Typical indoor walking pace, meters per second. */
var WALK_SPEED_MPS = 1.3;
var ROUTING_REVISION = 'grainger-access-v2';

// C3 upserts do not delete removed edges. Never mix the old wall-crossing
// graph with the replacement geometry. Other buildings retain their own data.
function currentGeometry(rows, buildingId) {
  if (buildingId !== 'grainger') return rows;
  return rows.filter(function (row) { return row.routingRevision === ROUTING_REVISION; });
}

/** Fallback image scale when a Floor does not declare pixelsPerMeter. */
var DEFAULT_PIXELS_PER_METER = 14.0;

/*
 * Fixed cost of summoning and boarding an elevator, in seconds.
 *
 * Deliberately pessimistic. In a busy academic building at class change the wait
 * is routinely 30-60s, and this is the single number that decides whether a
 * student is told to take the stairs. At a more optimistic 25s a two-floor climb
 * scored 45s by elevator against 44s by stairs — a one-second tie, meaning the
 * route A* returned was decided by rounding-level differences in walking
 * distance to the shaft rather than by anything real. 40s makes stairs
 * decisively better for one or two floors, which is what a hurried student
 * actually does, while the elevator still wins for longer climbs.
 *
 * This does not affect heuristic admissibility: the wait is never included in
 * the A* heuristic, and adding cost to a real edge can only widen the margin by
 * which the heuristic underestimates.
 */
var ELEVATOR_WAIT_SECONDS = 40.0;

/** Elevator ride time per floor traversed, in seconds. */
var ELEVATOR_PER_FLOOR_SECONDS = 10.0;

/** Stair climb time per floor, upward, in seconds. */
var STAIR_UP_PER_FLOOR_SECONDS = 22.0;

/** Stair descent time per floor, in seconds — faster than climbing. */
var STAIR_DOWN_PER_FLOOR_SECONDS = 15.0;

/*
 * The A* heuristic is deflated by this factor before use. Straight-line pixel
 * distance converted to time is admissible in theory, but only if every authored
 * NavEdge#seconds is at least its own straight-line travel time. Hand-authored
 * seed data does not always honor that, and an inflated heuristic would let A*
 * return a sub-optimal path while still claiming success. Shaving 10% keeps the
 * heuristic safely below the true remaining cost at the price of exploring a few
 * extra nodes, which is irrelevant at this graph size.
 */
var HEURISTIC_SAFETY = 0.9;

/** Default and maximum result counts for searchRooms. */
var SEARCH_DEFAULT_LIMIT = 10;
var SEARCH_MAX_LIMIT = 50;

var NODE_INCLUDE =
  'this, floor.id, floor.level, floor.name, floor.pixelsPerMeter, floor.building.id';

/**
 * Minimal binary min-heap keyed on numeric priority.
 *
 * A sorted-array frontier would be O(n) per insert; for a building-sized graph
 * either is fast, but the heap keeps A* honest if the graph grows to campus
 * scale.
 */
function MinHeap() {
  this.items = [];
}

MinHeap.prototype.push = function (key, priority) {
  this.items.push({ key: key, priority: priority });
  var i = this.items.length - 1;
  while (i > 0) {
    var parent = (i - 1) >> 1;
    if (this.items[parent].priority <= this.items[i].priority) break;
    var tmp = this.items[parent];
    this.items[parent] = this.items[i];
    this.items[i] = tmp;
    i = parent;
  }
};

MinHeap.prototype.pop = function () {
  if (this.items.length === 0) return null;
  var top = this.items[0];
  var last = this.items.pop();
  if (this.items.length > 0) {
    this.items[0] = last;
    var i = 0;
    var n = this.items.length;
    for (;;) {
      var left = 2 * i + 1;
      var right = left + 1;
      var smallest = i;
      if (left < n && this.items[left].priority < this.items[smallest].priority) smallest = left;
      if (right < n && this.items[right].priority < this.items[smallest].priority) smallest = right;
      if (smallest === i) break;
      var tmp = this.items[smallest];
      this.items[smallest] = this.items[i];
      this.items[i] = tmp;
      i = smallest;
    }
  }
  return top.key;
};

MinHeap.prototype.isEmpty = function () {
  return this.items.length === 0;
};

/** Pixel scale for a floor, falling back to the building-wide default. */
function pixelsPerMeterFor(node) {
  if (node && node.floor && node.floor.pixelsPerMeter) {
    return node.floor.pixelsPerMeter;
  }
  return DEFAULT_PIXELS_PER_METER;
}

/** Straight-line pixel distance between two nodes on the same floor. */
function pixelDistance(a, b) {
  var dx = a.imageX - b.imageX;
  var dy = a.imageY - b.imageY;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Friendly label for a vertical connector, preferring its authored name. */
function connectorLabel(node) {
  if (node.name) return node.name;
  if (node.connectorKey) return node.connectorKey;
  return node.kind === 'elevator' ? 'the elevator' : 'the stairs';
}

/** Friendly label for a destination, preferring room number then name. */
function destinationLabel(node) {
  if (node.roomNumber && node.name) return node.roomNumber + ' (' + node.name + ')';
  if (node.roomNumber) return node.roomNumber;
  if (node.name) return node.name;
  return 'your destination';
}

/**
 * Cost in seconds of riding a connector between two floors.
 *
 * Returns null when the move is not permitted — a stair connector in step-free
 * mode, or a connector pairing that is not actually a vertical move.
 */
function connectorCost(fromNode, toNode, stepFree) {
  var levelDelta = toNode.floor.level - fromNode.floor.level;
  if (levelDelta === 0) return null;
  var floors = Math.abs(levelDelta);

  if (fromNode.kind === 'elevator') {
    return ELEVATOR_WAIT_SECONDS + ELEVATOR_PER_FLOOR_SECONDS * floors;
  }
  if (fromNode.kind === 'stairs') {
    if (stepFree) return null;
    var perFloor = levelDelta > 0 ? STAIR_UP_PER_FLOOR_SECONDS : STAIR_DOWN_PER_FLOOR_SECONDS;
    return perFloor * floors;
  }
  return null;
}

/**
 * Load every node and edge for a building and assemble an adjacency map.
 *
 * Cross-floor adjacency is synthesized here from shared MapNode#connectorKey
 * values rather than read from NavEdge; see NavRouter.c3typ for why.
 */
function buildGraph(buildingId, stepFree) {
  var nodeRes = MapNode.fetch({
    filter: Filter.eq('floor.building.id', buildingId),
    include: NODE_INCLUDE,
    limit: -1,
  });
  var nodes = currentGeometry(nodeRes.objs || [], buildingId);

  var edgeRes = NavEdge.fetch({
    filter: Filter.eq('fromNode.floor.building.id', buildingId),
    include: 'this, fromNode.id, toNode.id',
    limit: -1,
  });
  var edges = currentGeometry(edgeRes.objs || [], buildingId);

  var nodesById = {};
  var i;
  for (i = 0; i < nodes.length; i++) {
    // In step-free mode a stairwell node is not a place a wheelchair user can be.
    if (stepFree && nodes[i].stepFree === false) continue;
    nodesById[nodes[i].id] = nodes[i];
  }

  var adjacency = {};
  function addLink(fromId, toId, seconds, meters, viaConnector) {
    if (!adjacency[fromId]) adjacency[fromId] = [];
    adjacency[fromId].push({
      to: toId,
      seconds: seconds,
      meters: meters || 0,
      viaConnector: viaConnector || null,
    });
  }

  for (i = 0; i < edges.length; i++) {
    var e = edges[i];
    if (stepFree && e.stepFree === false) continue;
    if (!e.fromNode || !e.toNode) continue;
    if (!nodesById[e.fromNode.id] || !nodesById[e.toNode.id]) continue;
    addLink(e.fromNode.id, e.toNode.id, e.seconds, e.meters, null);
  }

  // Synthesize vertical links between same-key connector nodes on other floors.
  var byConnector = {};
  for (i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    if (!n.connectorKey || !nodesById[n.id]) continue;
    if (!byConnector[n.connectorKey]) byConnector[n.connectorKey] = [];
    byConnector[n.connectorKey].push(n);
  }

  var keys = Object.keys(byConnector);
  for (i = 0; i < keys.length; i++) {
    var group = byConnector[keys[i]];
    for (var a = 0; a < group.length; a++) {
      for (var b = 0; b < group.length; b++) {
        if (a === b) continue;
        var cost = connectorCost(group[a], group[b], stepFree);
        if (cost === null) continue;
        addLink(group[a].id, group[b].id, cost, 0, keys[i]);
      }
    }
  }

  return { nodesById: nodesById, adjacency: adjacency };
}

/**
 * Admissible time-to-go estimate between two nodes.
 *
 * Within a floor this is deflated straight-line walking time. Across floors we
 * add the cheapest conceivable vertical move (an elevator ride with no wait),
 * which keeps the estimate below any real multi-floor path.
 */
function heuristic(a, b) {
  var sameFloor = a.floor && b.floor && a.floor.id === b.floor.id;
  var horizontalSeconds = 0;
  if (sameFloor) {
    var meters = pixelDistance(a, b) / pixelsPerMeterFor(a);
    horizontalSeconds = (meters / WALK_SPEED_MPS) * HEURISTIC_SAFETY;
  }
  var verticalSeconds = 0;
  if (!sameFloor && a.floor && b.floor) {
    var floors = Math.abs(b.floor.level - a.floor.level);
    verticalSeconds = ELEVATOR_PER_FLOOR_SECONDS * floors * HEURISTIC_SAFETY;
  }
  return horizontalSeconds + verticalSeconds;
}

/** Empty failure route carrying an explanation for the user. */
function failedRoute(message, startNodeId, destNodeId, stepFree) {
  return {
    routingRevision: ROUTING_REVISION,
    found: false,
    message: message,
    legs: [],
    totalSeconds: 0,
    totalMeters: 0,
    floorsTraversed: 0,
    startNodeId: startNodeId || null,
    destNodeId: destNodeId || null,
    stepFree: !!stepFree,
  };
}

/*
 * Turn thresholds for RouteStep, in degrees between consecutive hop headings.
 * Below TURN_MIN the hops are treated as one straight walk and merged; above
 * TURN_AROUND_MIN the student is doubling back.
 */
var TURN_MIN_DEGREES = 30;
var TURN_AROUND_MIN_DEGREES = 150;

/** RouteStep#kind values; see RouteStep.c3typ. */
var STEP_START = 'start';
var STEP_STRAIGHT = 'straight';
var STEP_TURN = 'turn';
var STEP_CONNECTOR = 'connector';
var STEP_ARRIVE = 'arrive';

/** Results of turnDirection. */
var DIR_STRAIGHT = 'straight';
var DIR_LEFT = 'left';
var DIR_RIGHT = 'right';
var DIR_AROUND = 'around';

/**
 * Classify the change of heading from h1 to h2, both {dx, dy} in floor-plan
 * pixels, as straight, left, right, or around.
 *
 * Image y grows downward, so on screen a positive cross product is a
 * clockwise, i.e. right, turn (east (1,0) then south (0,1) gives +1). That is
 * the opposite of the math-axes rule. Neither vector may be zero-length;
 * callers skip zero-length hops before calling. Never throws.
 */
function turnDirection(h1, h2) {
  var cross = h1.dx * h2.dy - h1.dy * h2.dx;
  var dot = h1.dx * h2.dx + h1.dy * h2.dy;
  var degrees = (Math.atan2(Math.abs(cross), dot) * 180) / Math.PI;
  if (degrees < TURN_MIN_DEGREES) return DIR_STRAIGHT;
  if (degrees > TURN_AROUND_MIN_DEGREES) return DIR_AROUND;
  return cross > 0 ? DIR_RIGHT : DIR_LEFT;
}

/** A node worth naming at a turn: a numbered room or a stair/elevator. Null otherwise. */
function landmarkLabel(node) {
  if (node.roomNumber) return node.roomNumber;
  if (node.connectorKey || node.kind === 'elevator' || node.kind === 'stairs') return connectorLabel(node);
  return null;
}

/** Meters as a student reads them: whole meters, at least 1 for any real walk. */
function metersText(meters) {
  return Math.max(1, Math.round(meters)) + ' m';
}

/** One decimal place, matching how findRoute rounds route totals. */
function roundTenth(x) {
  return Math.round(x * 10) / 10;
}

/**
 * Build the RouteStep list for one leg.
 *
 * - leg: the assembled leg (points, floorLevel, floorName, exitConnectorKey).
 * - hops: the leg's horizontal hops in travel order, each
 *   {fromIndex, toIndex, meters, seconds}, indexing leg.points.
 * - nodesById: the routing graph's nodes.
 * - arrivedFromNode: the connector node on the previous floor this leg was
 *   reached from, or null for the first leg.
 * - destNode: the route's destination when this is the last leg, else null.
 *
 * Collinear hops (under TURN_MIN_DEGREES from the previous hop) merge into
 * the current step; we compare each hop with the previous hop rather than with
 * the step's first heading, so a gentle curve made of many small bends stays
 * one step even after its total drift exceeds 30 degrees. Accepted
 * simplification: the seed hallways are straight.
 *
 * The final hop into the destination is the doorway: when it bends left or
 * right, it becomes the arrive step instead of a separate turn step. The
 * arrive step then says which side the room is on, names the landmark where
 * the doorway leaves the hallway, and carries that hop's meters and seconds
 * (otherwise arrive is zero meters). Zero-length hops add their meters to the
 * current step without changing heading.
 *
 * Total: never throws on a valid leg, including a one-point leg with no hops.
 * Step meters and seconds sum to the hop sums (before per-step rounding).
 */
function buildSteps(leg, hops, nodesById, arrivedFromNode, destNode) {
  var lastIndex = leg.points.length - 1;
  var steps = [];
  var walk = null; // the step currently accumulating hops
  var heading = null;
  var doorway = null; // {side, fromIndex, meters, seconds} when the last hop bends into the room
  var i;

  function nodeAt(index) {
    return nodesById[leg.points[index].nodeId];
  }

  if (arrivedFromNode) {
    var arrivalNode = nodeAt(0);
    var upOrDown = leg.floorLevel > arrivedFromNode.floor.level ? 'up' : 'down';
    steps.push({
      kind: STEP_CONNECTOR,
      text:
        'Take ' + connectorLabel(arrivalNode) + ' ' + upOrDown + ' to ' + (leg.floorName || 'Level ' + leg.floorLevel),
      meters: 0,
      seconds: 0,
      pointIndex: 0,
      turn: null,
      endIndex: 0,
    });
  }

  function openWalk(kind, turn, fromIndex) {
    walk = { kind: kind, text: '', meters: 0, seconds: 0, pointIndex: fromIndex, turn: turn, endIndex: fromIndex };
    steps.push(walk);
  }

  for (i = 0; i < hops.length; i++) {
    var hop = hops[i];
    var from = leg.points[hop.fromIndex];
    var to = leg.points[hop.toIndex];
    var h = { dx: to.x - from.x, dy: to.y - from.y };
    var zeroLength = h.dx === 0 && h.dy === 0;
    var dir = zeroLength || !heading ? DIR_STRAIGHT : turnDirection(heading, h);
    var isDoorway = destNode && i === hops.length - 1 && to.nodeId === destNode.id;

    if (isDoorway && walk && (dir === DIR_LEFT || dir === DIR_RIGHT)) {
      doorway = { side: dir, fromIndex: hop.fromIndex, meters: hop.meters, seconds: hop.seconds };
      continue;
    }
    if (!walk) {
      openWalk(arrivedFromNode ? STEP_STRAIGHT : STEP_START, null, hop.fromIndex);
    } else if (dir !== DIR_STRAIGHT) {
      openWalk(STEP_TURN, dir, hop.fromIndex);
    }

    walk.meters += hop.meters;
    walk.seconds += hop.seconds;
    walk.endIndex = hop.toIndex;
    if (!zeroLength) heading = h;
  }

  // A first leg that never walks (the start is a connector) still says where to start.
  if (!arrivedFromNode && steps.length === 0) openWalk(STEP_START, null, 0);

  var boardLabel = leg.exitConnectorKey ? connectorLabel(nodeAt(lastIndex)) : null;
  var doorLandmark = doorway ? landmarkLabel(nodeAt(doorway.fromIndex)) : null;
  for (i = 0; i < steps.length; i++) {
    var step = steps[i];
    if (step.kind === STEP_CONNECTOR) continue;
    var walkText = step.meters > 0 ? 'walk ' + metersText(step.meters) : '';
    if (walkText && boardLabel && step.endIndex === lastIndex) walkText += ' to ' + boardLabel;
    else if (walkText && doorLandmark && step.endIndex === doorway.fromIndex) walkText += ' to ' + doorLandmark;

    if (step.kind === STEP_START) {
      var startNode = nodeAt(step.pointIndex);
      var startLabel = startNode.name || startNode.roomNumber;
      if (!walkText) step.text = 'Start at ' + (startLabel || 'your starting point');
      else step.text = startLabel ? 'From ' + startLabel + ', ' + walkText : capitalize(walkText);
    } else if (step.kind === STEP_STRAIGHT) {
      step.text = capitalize(walkText || 'continue straight');
    } else {
      var landmark = landmarkLabel(nodeAt(step.pointIndex));
      step.text =
        'Turn ' + step.turn + (landmark ? ' at ' + landmark : '') + (walkText ? ', then ' + walkText : '');
    }
  }

  if (destNode) {
    var destText = destinationLabel(destNode);
    var arrive = { kind: STEP_ARRIVE, text: '', meters: 0, seconds: 0, pointIndex: lastIndex };
    if (destNode.labelX !== undefined && destNode.labelX !== null) {
      arrive.text = 'You have reached the mapped access point for ' + destText;
    } else if (doorway) {
      arrive.text = destText + ' is on your ' + doorway.side + (doorLandmark ? ' at ' + doorLandmark : '');
      arrive.meters = doorway.meters;
      arrive.seconds = doorway.seconds;
      arrive.pointIndex = doorway.fromIndex;
    } else if (hops.length === 0) {
      arrive.text = 'You have arrived at ' + destText;
    } else {
      arrive.text = destText + ' is straight ahead';
    }
    steps.push(arrive);
  }

  // Strip builder-only fields so only the RouteStep shape leaves this function.
  var out = [];
  for (i = 0; i < steps.length; i++) {
    out.push({
      kind: steps[i].kind,
      text: steps[i].text,
      meters: roundTenth(steps[i].meters),
      seconds: roundTenth(steps[i].seconds),
      pointIndex: steps[i].pointIndex,
    });
  }
  return out;
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Split an A* node path into one RouteLeg per floor and phrase the per-leg
 * instructions and turn-by-turn steps.
 */
function assembleLegs(path, adjacency, nodesById, destNode) {
  var legs = [];
  var legHops = []; // per leg, the hops buildSteps needs; kept out of the result
  var current = null;
  var currentHops = null;
  var totalSeconds = 0;
  var totalMeters = 0;
  var i;

  for (i = 0; i < path.length; i++) {
    var node = nodesById[path[i]];
    var floorId = node.floor ? node.floor.id : 'unknown';

    if (!current || current.floorId !== floorId) {
      if (current) {
        legs.push(current);
        legHops.push(currentHops);
      }
      currentHops = [];
      current = {
        floorId: floorId,
        floorLevel: node.floor ? node.floor.level : 0,
        floorName: node.floor ? node.floor.name : null,
        points: [],
        seconds: 0,
        meters: 0,
        instruction: '',
        exitConnectorKey: null,
      };
    }

    current.points.push({
      nodeId: node.id,
      x: node.imageX,
      y: node.imageY,
      kind: node.kind,
    });

    // Attribute the cost of the hop leaving this node.
    if (i < path.length - 1) {
      var links = adjacency[path[i]] || [];
      var chosen = null;
      for (var k = 0; k < links.length; k++) {
        if (links[k].to === path[i + 1]) {
          if (!chosen || links[k].seconds < chosen.seconds) chosen = links[k];
        }
      }
      if (chosen) {
        totalSeconds += chosen.seconds;
        if (chosen.viaConnector) {
          // Vertical hop: ends this leg and names the shaft to board.
          current.exitConnectorKey = chosen.viaConnector;
        } else {
          current.seconds += chosen.seconds;
          current.meters += chosen.meters;
          totalMeters += chosen.meters;
          // A non-connector edge between floors would be a seed error; its
          // cost still counts above, but it has no on-floor geometry to step.
          var nextNode = nodesById[path[i + 1]];
          var nextFloorId = nextNode.floor ? nextNode.floor.id : 'unknown';
          if (nextFloorId === floorId) {
            var fromIndex = current.points.length - 1;
            currentHops.push({
              fromIndex: fromIndex,
              toIndex: fromIndex + 1,
              meters: chosen.meters,
              seconds: chosen.seconds,
            });
          }
        }
      }
    }
  }
  if (current) {
    legs.push(current);
    legHops.push(currentHops);
  }

  // Phrase instructions now that leg boundaries and connectors are known.
  var destText = destinationLabel(destNode);
  for (i = 0; i < legs.length; i++) {
    var leg = legs[i];
    var arrivingVia = i > 0 ? legs[i - 1].exitConnectorKey : null;
    var boardNode = null;
    if (leg.exitConnectorKey) {
      var lastPoint = leg.points[leg.points.length - 1];
      boardNode = nodesById[lastPoint.nodeId];
    }

    if (arrivingVia) {
      var arrivalNode = nodesById[leg.points[0].nodeId];
      var vehicle = connectorLabel(arrivalNode);
      var prefix = 'Take ' + vehicle + ' to ' + (leg.floorName || 'Level ' + leg.floorLevel);
      leg.instruction = leg.exitConnectorKey
        ? prefix + ', then walk to ' + connectorLabel(boardNode)
        : prefix + ', then walk to ' + destText;
    } else if (leg.exitConnectorKey) {
      leg.instruction = 'Walk to ' + connectorLabel(boardNode);
    } else {
      leg.instruction = 'Walk to ' + destText;
    }

    var arrivedFromNode = arrivingVia ? nodesById[legs[i - 1].points[legs[i - 1].points.length - 1].nodeId] : null;
    var isLastLeg = i === legs.length - 1;
    leg.steps = buildSteps(leg, legHops[i], nodesById, arrivedFromNode, isLastLeg ? destNode : null);
  }

  return { legs: legs, totalSeconds: totalSeconds, totalMeters: totalMeters };
}

function findRoute(startNodeId, destNodeId, stepFree) {
  var wantStepFree = !!stepFree;

  if (!startNodeId || !destNodeId) {
    return failedRoute('A start and a destination are both required.', startNodeId, destNodeId, wantStepFree);
  }
  if (startNodeId === destNodeId) {
    return failedRoute("You're already there.", startNodeId, destNodeId, wantStepFree);
  }

  var startProbe = MapNode.fetch({
    filter: Filter.eq('id', startNodeId),
    include: NODE_INCLUDE,
    limit: 1,
  });
  if (!startProbe.objs || startProbe.objs.length === 0) {
    return failedRoute('Could not find your starting point on the map.', startNodeId, destNodeId, wantStepFree);
  }
  var startNode = startProbe.objs[0];
  if (!startNode.floor || !startNode.floor.building) {
    return failedRoute('Starting point is not attached to a building.', startNodeId, destNodeId, wantStepFree);
  }
  var buildingId = startNode.floor.building.id;

  var graph = buildGraph(buildingId, wantStepFree);
  var nodesById = graph.nodesById;
  var adjacency = graph.adjacency;

  if (!nodesById[startNodeId]) {
    return failedRoute(
      wantStepFree
        ? 'Your starting point is not reachable without stairs.'
        : 'Your starting point is not part of the walkable map.',
      startNodeId,
      destNodeId,
      wantStepFree
    );
  }
  if (!nodesById[destNodeId]) {
    return failedRoute(
      wantStepFree
        ? 'That destination has no step-free access in our map.'
        : 'That destination is not on the walkable map.',
      startNodeId,
      destNodeId,
      wantStepFree
    );
  }

  var destNode = nodesById[destNodeId];

  // --- A* ---
  var gScore = {};
  var cameFrom = {};
  var closed = {};
  gScore[startNodeId] = 0;

  var open = new MinHeap();
  open.push(startNodeId, heuristic(nodesById[startNodeId], destNode));

  var reached = false;
  while (!open.isEmpty()) {
    var currentId = open.pop();
    if (closed[currentId]) continue;
    if (currentId === destNodeId) {
      reached = true;
      break;
    }
    closed[currentId] = true;

    var links = adjacency[currentId] || [];
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      if (closed[link.to]) continue;
      if (!nodesById[link.to]) continue;
      var tentative = gScore[currentId] + link.seconds;
      if (gScore[link.to] === undefined || tentative < gScore[link.to]) {
        gScore[link.to] = tentative;
        cameFrom[link.to] = currentId;
        open.push(link.to, tentative + heuristic(nodesById[link.to], destNode));
      }
    }
  }

  if (!reached) {
    return failedRoute(
      wantStepFree
        ? 'No step-free route to ' + destinationLabel(destNode) + '. The only access we know of involves stairs.'
        : 'No walkable route found to ' + destinationLabel(destNode) + '.',
      startNodeId,
      destNodeId,
      wantStepFree
    );
  }

  // Reconstruct the path, start to destination.
  var path = [destNodeId];
  var walker = destNodeId;
  while (cameFrom[walker] !== undefined) {
    walker = cameFrom[walker];
    path.unshift(walker);
  }

  var assembled = assembleLegs(path, adjacency, nodesById, destNode);
  var floorsSeen = {};
  for (var j = 0; j < assembled.legs.length; j++) {
    floorsSeen[assembled.legs[j].floorId] = true;
  }

  return {
    routingRevision: ROUTING_REVISION,
    found: true,
    message: null,
    legs: assembled.legs,
    totalSeconds: Math.round(assembled.totalSeconds * 10) / 10,
    totalMeters: Math.round(assembled.totalMeters * 10) / 10,
    floorsTraversed: Object.keys(floorsSeen).length,
    startNodeId: startNodeId,
    destNodeId: destNodeId,
    stepFree: wantStepFree,
  };
}

function searchRooms(buildingId, query, limit) {
  var capped = limit ? Math.min(limit, SEARCH_MAX_LIMIT) : SEARCH_DEFAULT_LIMIT;
  if (!buildingId || !query) return [];
  var trimmed = ('' + query).trim();
  if (trimmed.length === 0) return [];
  var needle = trimmed.toLowerCase();

  var res = MapNode.fetch({
    filter: Filter.eq('floor.building.id', buildingId),
    include: NODE_INCLUDE,
    limit: -1,
  });
  var nodes = currentGeometry(res.objs || [], buildingId);

  // Rank so that a typed room number beats a name that merely contains it.
  var scored = [];
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    var roomNumber = (n.roomNumber || '').toLowerCase();
    var name = (n.name || '').toLowerCase();
    var aliases = (n.searchAliases || '').toLowerCase();
    var score = -1;

    if (roomNumber && roomNumber === needle) score = 0;
    else if (roomNumber && roomNumber.indexOf(needle) === 0) score = 1;
    else if (name && name.indexOf(needle) === 0) score = 2;
    else if (name && name.indexOf(needle) >= 0) score = 3;
    else if (aliases && aliases.indexOf(needle) >= 0) score = 4;
    else if (roomNumber && roomNumber.indexOf(needle) >= 0) score = 5;

    if (score >= 0) scored.push({ node: n, score: score });
  }

  scored.sort(function (x, y) {
    if (x.score !== y.score) return x.score - y.score;
    var xr = x.node.roomNumber || '';
    var yr = y.node.roomNumber || '';
    return xr < yr ? -1 : xr > yr ? 1 : 0;
  });

  var out = [];
  for (var k = 0; k < scored.length && out.length < capped; k++) {
    out.push(scored[k].node);
  }
  return out;
}

function routeToRoom(buildingId, startNodeId, roomQuery, stepFree) {
  var matches = searchRooms(buildingId, roomQuery, 1);
  if (!matches || matches.length === 0) {
    return failedRoute('We could not find "' + roomQuery + '" in this building.', startNodeId, null, !!stepFree);
  }
  return findRoute(startNodeId, matches[0].id, stepFree);
}

function nearestNode(floorId, imageX, imageY) {
  if (!floorId) return null;
  var res = MapNode.fetch({
    filter: Filter.eq('floor.id', floorId),
    include: NODE_INCLUDE,
    limit: -1,
  });
  var nodes = (res.objs || []).filter(function (node) {
    return !node.floor || !node.floor.building || node.floor.building.id !== 'grainger' || node.routingRevision === ROUTING_REVISION;
  });
  if (nodes.length === 0) return null;

  var best = null;
  var bestDist = Number.MAX_VALUE;
  for (var i = 0; i < nodes.length; i++) {
    var dx = nodes[i].imageX - imageX;
    var dy = nodes[i].imageY - imageY;
    var d = dx * dx + dy * dy;
    if (d < bestDist) {
      bestDist = d;
      best = nodes[i];
    }
  }
  return best;
}

function graphForBuilding(buildingId) {
  var nodeRes = MapNode.fetch({
    filter: Filter.eq('floor.building.id', buildingId),
    include: NODE_INCLUDE,
    limit: -1,
  });
  var nodes = currentGeometry(nodeRes.objs || [], buildingId);

  var edgeRes = NavEdge.fetch({
    filter: Filter.eq('fromNode.floor.building.id', buildingId),
    include: 'this, fromNode.id, toNode.id',
    limit: -1,
  });
  var edges = currentGeometry(edgeRes.objs || [], buildingId);

  return {
    routingRevision: ROUTING_REVISION,
    buildingId: buildingId,
    nodes: nodes,
    edges: edges,
    nodeCount: nodes.length,
    edgeCount: edges.length,
  };
}
