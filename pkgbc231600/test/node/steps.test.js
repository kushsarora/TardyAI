// Turn-by-turn RouteStep acceptance tests for src/NavRouter.js, run offline
// over the data/ seed graph plus small synthetic fixtures.
// Run: node --test pkgbc231600/test/node/*.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { seed, loadRouter } = require('./harness.js');

const ROOM_3335 = 'n-f3-r3335';
const WEST_STAIRS_F1 = 'n-f1-stair-w';
const STEP_KINDS = new Set(['start', 'straight', 'turn', 'connector', 'arrive']);

function westEntranceId() {
  const matches = seed().nodes.filter((n) => n.name === 'West Entrance');
  assert.equal(matches.length, 1, 'seed data should have exactly one "West Entrance" node');
  return matches[0].id;
}

function demoRoute(stepFree) {
  const route = loadRouter().findRoute(westEntranceId(), ROOM_3335, stepFree);
  assert.equal(route.found, true, route.message);
  return route;
}

function allSteps(route) {
  return route.legs.flatMap((leg) => Array.from(leg.steps));
}

/** Invariants every found route must satisfy, whatever its geometry. */
function assertStepInvariants(route) {
  route.legs.forEach((leg, i) => {
    assert.ok(leg.steps && leg.steps.length > 0, `leg ${i} has no steps`);
    const steps = Array.from(leg.steps);
    for (const s of steps) {
      assert.ok(STEP_KINDS.has(s.kind), `unknown step kind ${s.kind}`);
      assert.equal(typeof s.text, 'string');
      assert.ok(s.text.length > 0, 'step text must not be empty');
      assert.ok(Number.isInteger(s.pointIndex) && s.pointIndex >= 0 && s.pointIndex < leg.points.length,
        `pointIndex ${s.pointIndex} out of range for ${leg.points.length} points`);
      assert.ok(s.meters >= 0 && s.seconds >= 0);
    }
    const meters = steps.reduce((sum, s) => sum + s.meters, 0);
    assert.ok(Math.abs(meters - (leg.meters || 0)) <= 1,
      `leg ${i}: step meters ${meters} vs leg.meters ${leg.meters}`);
    assert.equal(steps[0].kind, i === 0 ? 'start' : 'connector', `leg ${i} opens with ${steps[0].kind}`);
    for (let k = 1; k < steps.length; k++) {
      assert.ok(!(steps[k - 1].kind === 'straight' && steps[k].kind === 'straight'),
        `leg ${i}: two consecutive straight steps at ${k}`);
    }
    const arrives = steps.filter((s) => s.kind === 'arrive');
    if (i === route.legs.length - 1) {
      assert.equal(steps[steps.length - 1].kind, 'arrive', 'last leg must end with arrive');
      assert.equal(arrives.length, 1);
    } else {
      assert.equal(arrives.length, 0, `non-final leg ${i} must not arrive`);
    }
  });
}

// --- seed data -------------------------------------------------------------

test('demo route (West Entrance L1 to 3335): steps satisfy every invariant and include a turn', () => {
  const route = demoRoute(false);
  assertStepInvariants(route);
  assert.ok(allSteps(route).some((s) => s.kind === 'turn'), 'demo route should have at least one turn');
  const last = route.legs[route.legs.length - 1].steps;
  assert.match(last[last.length - 1].text, /3335/);
});

test('demo route names the public elevator in an upward connector step', () => {
  const connectors = allSteps(demoRoute(false)).filter((s) => s.kind === 'connector');
  assert.equal(connectors.length, 1);
  assert.match(connectors[0].text, /Elevator C \(east\) up to Level 3/);
});

test('demo route: arrival stops at the room access point, without guessing a doorway side', () => {
  const steps = Array.from(demoRoute(false).legs[1].steps);
  assert.match(steps[steps.length - 1].text, /^You have reached the mapped access point for 3335/);
});

test('step-free demo route takes Elevator C and still satisfies every invariant', () => {
  const route = demoRoute(true);
  assertStepInvariants(route);
  const connectors = allSteps(route).filter((s) => s.kind === 'connector');
  assert.ok(connectors.some((s) => /Elevator C/.test(s.text)), connectors.map((s) => s.text).join(' | '));
  assert.ok(!allSteps(route).some((s) => /Stairs/.test(s.text)));
});

test('floor instructions agree with the corrected public elevator route', () => {
  const normal = demoRoute(false);
  assert.equal(normal.legs[0].instruction, 'Walk to Elevator C (east)');
  assert.equal(normal.legs[1].instruction, 'Take Elevator C (east) to Level 3, then walk to 3335 (Class Room 3335)');
  const stepFree = demoRoute(true);
  assert.equal(stepFree.legs[0].instruction, 'Walk to Elevator C (east)');
});

test('a route starting on a connector (one-point first leg) does not throw and says where to start', () => {
  let route;
  assert.doesNotThrow(() => { route = loadRouter().findRoute(WEST_STAIRS_F1, ROOM_3335, false); });
  assert.equal(route.found, true, route.message);
  assertStepInvariants(route);
  assert.equal(route.legs[0].points.length, 1);
  const first = Array.from(route.legs[0].steps);
  assert.equal(first.length, 1);
  assert.equal(first[0].text, 'Start at West Stairs');
  assert.equal(first[0].meters, 0);
});

test('every room on the seed map gets valid steps from the West Entrance, default and step-free', () => {
  const rooms = seed().nodes.filter((n) => n.kind === 'room');
  assert.ok(rooms.length > 0);
  const router = loadRouter();
  let checked = 0;
  for (const room of rooms) {
    for (const stepFree of [false, true]) {
      const route = router.findRoute(westEntranceId(), room.id, stepFree);
      if (!route.found) continue; // routability is milestone 4's all-rooms test
      assertStepInvariants(route);
      checked++;
    }
  }
  assert.ok(checked > 0, 'no seed room was routable');
});

// --- synthetic fixtures: pin the y-down turn sign --------------------------

const FLOOR = {
  id: 'fx-f1',
  building: { id: 'fx' },
  level: 1,
  name: 'Fixture Level',
  pixelsPerMeter: 10,
};

/**
 * One-floor graph from {id: [x, y, extra]} nodes and [a, b] undirected edges,
 * each edge priced at its pixel length / 10 meters.
 */
function fixture(nodeSpecs, edgePairs) {
  const nodes = Object.entries(nodeSpecs).map(([id, [x, y, extra]]) => ({
    id,
    floor: structuredClone(FLOOR),
    kind: 'hallway',
    imageX: x,
    imageY: y,
    stepFree: true,
    ...(extra || {}),
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = edgePairs.flatMap(([a, b]) => {
    const meters = Math.hypot(byId.get(a).imageX - byId.get(b).imageX, byId.get(a).imageY - byId.get(b).imageY) / 10;
    const mk = (f, t) => ({ id: `e-${f}-${t}`, fromNode: { id: f }, toNode: { id: t }, seconds: meters / 1.3, meters, stepFree: true });
    return [mk(a, b), mk(b, a)];
  });
  return { floors: [FLOOR], nodes, edges };
}

/** Route over a fixture; returns the single leg's steps as plain objects. */
function fixtureSteps(data, from, to) {
  const route = loadRouter(data).findRoute(from, to, false);
  assert.equal(route.found, true, route.message);
  assertStepInvariants(route);
  assert.equal(route.legs.length, 1);
  return Array.from(route.legs[0].steps).map((s) => ({ ...s }));
}

function turns(steps) {
  return steps.filter((s) => s.kind === 'turn').map((s) => s.text);
}

// Corridor east past M to the corner room 3110 at B, then south past C to D.
// M keeps the last hop of the reverse walk collinear, so it is a real turn
// and not a doorway into the destination.
//   A(0,0) -- M(50,0) -- B(100,0)
//                          |
//                        C(100,100)
//                          |
//                        D(100,200)
const L_SHAPE = {
  A: [0, 0],
  M: [50, 0],
  B: [100, 0, { kind: 'room', roomNumber: '3110' }],
  C: [100, 100],
  D: [100, 200, { kind: 'room', roomNumber: '3999' }],
};
const L_EDGES = [['A', 'M'], ['M', 'B'], ['B', 'C'], ['C', 'D']];

// Mirror image across the vertical axis: corridor west, then south.
const L_MIRROR = {
  A: [100, 0],
  M: [50, 0],
  B: [0, 0, { kind: 'room', roomNumber: '3110' }],
  C: [0, 100],
  D: [0, 200, { kind: 'room', roomNumber: '3999' }],
};

test('L fixture: east then south on screen is a right turn, named at its landmark', () => {
  const steps = fixtureSteps(fixture(L_SHAPE, L_EDGES), 'A', 'D');
  assert.deepEqual(turns(steps), ['Turn right at 3110, then walk 20 m']);
  assert.deepEqual(steps.map((s) => s.kind), ['start', 'turn', 'arrive']);
  assert.equal(steps[steps.length - 1].text, '3999 is straight ahead');
});

test('L fixture walked backwards: north then west is a left turn', () => {
  const steps = fixtureSteps(fixture(L_SHAPE, L_EDGES), 'D', 'A');
  assert.deepEqual(turns(steps), ['Turn left at 3110, then walk 10 m']);
});

test('mirrored L fixture flips left and right in both directions', () => {
  const data = fixture(L_MIRROR, L_EDGES);
  assert.deepEqual(turns(fixtureSteps(data, 'A', 'D')), ['Turn left at 3110, then walk 20 m']);
  assert.deepEqual(turns(fixtureSteps(data, 'D', 'A')), ['Turn right at 3110, then walk 10 m']);
});

test('a room off the last hop is on the side the walker turns toward', () => {
  // Corridor east A -> B, room C just south of B (on screen): a right-hand door.
  const right = fixture({ A: [0, 0], B: [100, 0], C: [100, 40, { kind: 'room', roomNumber: '3200' }] },
    [['A', 'B'], ['B', 'C']]);
  const r = fixtureSteps(right, 'A', 'C');
  assert.deepEqual(r.map((s) => s.kind), ['start', 'arrive']);
  assert.equal(r[1].text, '3200 is on your right');
  assert.equal(r[1].meters, 4); // the doorway hop's meters ride on the arrive step

  const left = fixture({ A: [0, 0], B: [100, 0], C: [100, -40, { kind: 'room', roomNumber: '3201' }] },
    [['A', 'B'], ['B', 'C']]);
  assert.equal(fixtureSteps(left, 'A', 'C')[1].text, '3201 is on your left');
});

test('collinear hops merge into one step, never one step per node', () => {
  const data = fixture({ A: [0, 0], B: [100, 0], C: [200, 5], D: [300, 0], E: [400, 0, { roomNumber: '3300' }] },
    [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E']]);
  const steps = fixtureSteps(data, 'A', 'E');
  assert.deepEqual(steps.map((s) => s.kind), ['start', 'arrive']);
  assert.equal(steps[0].text, 'Walk 40 m');
});

test('doubling back over 150 degrees says "Turn around"', () => {
  // East to B, back west to C (a spur), then south to D and E.
  const data = fixture(
    { A: [0, 0], B: [100, 0], C: [50, 5], D: [50, 100], E: [50, 200, { roomNumber: '3400' }] },
    [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E']]
  );
  const t = turns(fixtureSteps(data, 'A', 'E'));
  assert.equal(t.length, 2);
  assert.match(t[0], /^Turn around, then walk 5 m$/);
  // Heading roughly west, then south on screen: a left turn.
  assert.match(t[1], /^Turn left, then walk 20 m$/);
});

test('turnDirection pins the y-down sign directly', () => {
  const { turnDirection } = loadRouter();
  assert.equal(turnDirection({ dx: 1, dy: 0 }, { dx: 0, dy: 1 }), 'right');
  assert.equal(turnDirection({ dx: 1, dy: 0 }, { dx: 0, dy: -1 }), 'left');
  assert.equal(turnDirection({ dx: 1, dy: 0 }, { dx: 10, dy: 1 }), 'straight');
  assert.equal(turnDirection({ dx: 1, dy: 0 }, { dx: -1, dy: 0.01 }), 'around');
});
