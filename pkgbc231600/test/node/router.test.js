// Pins the README's routing claims against the real src/NavRouter.js, run
// offline over the data/ seed graph. Run: node --test pkgbc231600/test/node/*.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { seed, loadRouter } = require('./harness.js');

const BUILDING = 'grainger';
const ROOM_3335 = 'n-f3-r3335';
const WEST_STAIRS_F1 = 'n-f1-stair-w';
const ELEVATOR_C_F1 = 'n-f1-elev-e';

/** The seed node named "West Entrance" — looked up, not hardcoded, so the test follows the data. */
function westEntranceId() {
  const matches = seed().nodes.filter((n) => n.name === 'West Entrance');
  assert.equal(matches.length, 1, 'seed data should have exactly one "West Entrance" node');
  return matches[0].id;
}

function pointIds(route) {
  return route.legs.flatMap((leg) => leg.points.map((p) => p.nodeId));
}

function assertFailed(route, messagePattern) {
  assert.equal(route.found, false);
  assert.equal(typeof route.message, 'string');
  assert.ok(route.message.length > 0, 'failed route must explain itself');
  assert.match(route.message, messagePattern);
  // Not deepEqual(..., []): the array comes from the vm realm, so its prototype differs.
  assert.equal(route.legs.length, 0);
}

test('West Entrance (L1) to 3335 is found in ~3 min over 2 legs on 2 floors', () => {
  const route = loadRouter().findRoute(westEntranceId(), ROOM_3335, false);
  assert.equal(route.found, true, route.message);
  assert.equal(route.legs.length, 2);
  assert.equal(route.floorsTraversed, 2);
  assert.ok(route.totalSeconds >= 150 && route.totalSeconds <= 210,
    `expected ~3 min (150-210 s), got ${route.totalSeconds} s`);
  assert.equal(route.legs[0].floorLevel, 1);
  assert.equal(route.legs[1].floorLevel, 3);
});

test('default route climbs the West Stairs', () => {
  const route = loadRouter().findRoute(westEntranceId(), ROOM_3335, false);
  assert.ok(pointIds(route).includes(WEST_STAIRS_F1), 'default route should pass n-f1-stair-w');
  assert.match(route.legs[0].instruction, /West Stairs/);
  assert.match(route.legs[1].instruction, /3335/);
});

test('step-free swaps West Stairs for Elevator C, with a different ETA', () => {
  const router = loadRouter();
  const start = westEntranceId();
  const normal = router.findRoute(start, ROOM_3335, false);
  const stepFree = router.findRoute(start, ROOM_3335, true);

  assert.equal(stepFree.found, true, stepFree.message);
  assert.equal(stepFree.stepFree, true);
  const kinds = stepFree.legs.flatMap((leg) => leg.points.map((p) => p.kind));
  assert.ok(!kinds.includes('stairs'), `step-free route passes stairs: ${kinds.join(',')}`);
  assert.ok(!pointIds(stepFree).includes(WEST_STAIRS_F1));
  assert.ok(pointIds(stepFree).includes(ELEVATOR_C_F1), 'step-free route should board Elevator C on L1');
  assert.match(stepFree.legs[0].instruction, /Elevator C \(east\)/);
  assert.notEqual(stepFree.totalSeconds, normal.totalSeconds);
});

test('unknown destination or start id fails the route instead of throwing', () => {
  const router = loadRouter();
  const start = westEntranceId();
  let route;
  assert.doesNotThrow(() => { route = router.findRoute(start, 'n-does-not-exist', false); });
  assertFailed(route, /not on the walkable map/);
  assert.doesNotThrow(() => { route = router.findRoute('n-does-not-exist', ROOM_3335, false); });
  assertFailed(route, /starting point/);
});

test('routeToRoom: unmatched query fails; "3335" matches findRoute', () => {
  const router = loadRouter();
  const start = westEntranceId();
  let miss;
  assert.doesNotThrow(() => { miss = router.routeToRoom(BUILDING, start, 'zzzz', false); });
  assertFailed(miss, /could not find "zzzz"/);

  const byQuery = router.routeToRoom(BUILDING, start, '3335', false);
  const byId = router.findRoute(start, ROOM_3335, false);
  assert.equal(byQuery.found, true, byQuery.message);
  assert.equal(byQuery.destNodeId, ROOM_3335);
  assert.equal(byQuery.totalSeconds, byId.totalSeconds);
});

test('a room with no walkable edges fails the route instead of throwing', () => {
  const data = seed();
  data.nodes.push({
    id: 'n-test-isolated',
    floor: structuredClone(data.nodes.find((n) => n.id === ROOM_3335).floor),
    kind: 'room',
    imageX: 10,
    imageY: 10,
    stepFree: true,
    roomNumber: 'T-ISOLATED',
    name: 'Stranded Test Room',
  });
  let route;
  assert.doesNotThrow(() => { route = loadRouter(data).findRoute(westEntranceId(), 'n-test-isolated', false); });
  assertFailed(route, /No walkable route found to T-ISOLATED/);
});

test('step-free fails when the only way up is stairs, while the default route still works', () => {
  const data = seed();
  // Elevators out of service: drop their connectorKey so no vertical link is
  // synthesized. (Dropping edges into elevator nodes would also cut the
  // hallways, since some elevators sit inline in a corridor chain.)
  const elevators = data.nodes.filter((n) => n.kind === 'elevator');
  assert.ok(elevators.length > 0, 'seed data should contain elevators');
  for (const n of elevators) delete n.connectorKey;

  const router = loadRouter(data);
  const start = westEntranceId();
  let route;
  assert.doesNotThrow(() => { route = router.findRoute(start, ROOM_3335, true); });
  assertFailed(route, /No step-free route to 3335.*involves stairs/);
  // Guards against a fixture that is simply broken: stairs must still get there.
  assert.equal(router.findRoute(start, ROOM_3335, false).found, true);
});

test('same start and destination fails with "already there"', () => {
  const start = westEntranceId();
  assertFailed(loadRouter().findRoute(start, start, false), /already there/);
});

// In production the platform rejects blank `!string` args with Err.InvalidCall
// before this body runs (NavRouter.c3typ). This pins the body's own defensive path.
test('blank start or destination fails in the router body (defensive path)', () => {
  const router = loadRouter();
  assertFailed(router.findRoute('', ROOM_3335, false), /both required/);
  assertFailed(router.findRoute(westEntranceId(), '', false), /both required/);
});

test('stub rejects filter paths the router does not use', () => {
  const router = loadRouter();
  assert.throws(
    () => router.MapNode.fetch({ filter: router.Filter.eq('roomNumber', '3335'), limit: -1 }),
    /does not support filter path 'roomNumber'/
  );
});
