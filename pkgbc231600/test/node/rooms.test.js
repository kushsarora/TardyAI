// Pins the corridor graph's room coverage against the printed floor plans:
// every printed room number is a routable room node (or is listed, with a
// reason, as deliberately unmapped), every room hangs off its own door on a
// corridor, and routes only ever pass through corridor, door and connector
// nodes. Run: node --test pkgbc231600/test/node/*.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { seed, loadRouter } = require('./harness.js');

const PRINTED = readFixture('printed-rooms.json'); // {level: [number, ...]}, transcribed from the plans
const UNMAPPED = readFixture('unmapped-rooms.json'); // {level: {number: reason}}

const MAX_ROOM_EDGE_METERS = 15;
const WALK_SPEED_MPS = 1.3;
const DOOR_PENALTY_SECONDS = 3;
// Coordinates, meters and seconds are each stored to one decimal place, so a
// recomputed value can drift by one rounding step plus a little float error.
const ROUNDING = 0.1;
const ROOM_KINDS = new Set(['room', 'restroom']);

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

function westEntranceId(nodes) {
  const matches = nodes.filter((n) => n.name === 'West Entrance');
  assert.equal(matches.length, 1, 'seed data should have exactly one "West Entrance" node');
  return matches[0].id;
}

function readWaypoints() {
  const file = path.resolve(__dirname, '..', '..', 'data', 'Waypoint', 'Waypoint.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Room nodes keyed "<level>:<roomNumber>". */
function roomsByLevelAndNumber(nodes) {
  const out = new Map();
  for (const n of nodes) {
    if (n.kind !== 'room') continue;
    const key = `${n.floor.level}:${n.roomNumber}`;
    assert.ok(!out.has(key), `two room nodes for ${key}`);
    out.set(key, n);
  }
  return out;
}

test('every printed room is a room node with a matching waypoint, or unmapped with a reason', () => {
  const { nodes } = seed();
  const rooms = roomsByLevelAndNumber(nodes);
  const waypointLabels = new Set(readWaypoints().map((w) => `${w.floorLevel}:${w.label}`));
  const levels = Object.keys(PRINTED);
  assert.deepEqual(levels.sort(), ['1', '2', '3']);

  for (const level of levels) {
    const unmapped = UNMAPPED[level] || {};
    for (const number of PRINTED[level]) {
      const key = `${level}:${number}`;
      if (Object.hasOwn(unmapped, number)) {
        assert.ok(unmapped[number].length > 0, `${key} is unmapped without a reason`);
        assert.ok(!rooms.has(key), `${key} is both mapped and listed as unmapped`);
        continue;
      }
      assert.ok(rooms.has(key), `printed room ${key} has no room node`);
      assert.ok(waypointLabels.has(key), `printed room ${key} has no waypoint labelled ${number}`);
    }
    for (const number of Object.keys(unmapped)) {
      assert.ok(PRINTED[level].includes(number), `unmapped ${level}:${number} is not a printed number`);
    }
  }
  for (const key of rooms.keys()) {
    const [level, number] = key.split(':');
    assert.ok(PRINTED[level].includes(number), `room node ${key} is not in printed-rooms.json`);
  }
});

test('each room and restroom has exactly one edge pair, to its own door, at most 15 m long', () => {
  const { nodes, edges } = seed();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map();
  const into = new Map();
  for (const e of edges) {
    if (!out.has(e.fromNode.id)) out.set(e.fromNode.id, []);
    if (!into.has(e.toNode.id)) into.set(e.toNode.id, []);
    out.get(e.fromNode.id).push(e);
    into.get(e.toNode.id).push(e);
  }
  const doorOwners = new Map();
  for (const room of nodes.filter((n) => ROOM_KINDS.has(n.kind))) {
    const leaving = out.get(room.id) || [];
    const arriving = into.get(room.id) || [];
    assert.equal(leaving.length, 1, `${room.id} should have exactly one outgoing edge`);
    assert.equal(arriving.length, 1, `${room.id} should have exactly one incoming edge`);
    const door = byId.get(leaving[0].toNode.id);
    assert.equal(door.kind, 'door', `${room.id} should connect to a door node, not ${door.id}`);
    assert.equal(arriving[0].fromNode.id, door.id, `${room.id}: in and out edges use different doors`);
    for (const e of [leaving[0], arriving[0]]) {
      assert.equal(e.edgeType, 'door', `${e.id} should be a door edge`);
      assert.ok(e.meters <= MAX_ROOM_EDGE_METERS, `${e.id} is ${e.meters} m (max ${MAX_ROOM_EDGE_METERS})`);
    }
    assert.ok(!doorOwners.has(door.id), `${door.id} serves both ${doorOwners.get(door.id)} and ${room.id}`);
    doorOwners.set(door.id, room.id);
  }
  for (const n of nodes.filter((x) => x.kind === 'door')) {
    assert.ok(doorOwners.has(n.id), `door ${n.id} belongs to no room`);
  }
});

test('every edge stays on one floor and costs its pixel length at walking speed', () => {
  const { nodes, edges } = seed();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const e of edges) {
    const a = byId.get(e.fromNode.id);
    const b = byId.get(e.toNode.id);
    assert.equal(a.floor.id, b.floor.id, `${e.id} spans floors`);
    const meters = Math.hypot(a.imageX - b.imageX, a.imageY - b.imageY) / a.floor.pixelsPerMeter;
    assert.ok(Math.abs(e.meters - meters) <= ROUNDING, `${e.id}: ${e.meters} m, pixels say ${meters.toFixed(2)}`);
    const seconds = meters / WALK_SPEED_MPS + (e.edgeType === 'door' ? DOOR_PENALTY_SECONDS : 0);
    assert.ok(Math.abs(e.seconds - seconds) <= ROUNDING, `${e.id}: ${e.seconds} s, expected ${seconds.toFixed(2)}`);
    assert.ok(e.seconds > 0, `${e.id} costs nothing`);
  }
});

test('every mapped room is routable from the West Entrance, default and step-free, never through a room', () => {
  const { nodes } = seed();
  const start = westEntranceId(nodes);
  const router = loadRouter();
  const rooms = nodes.filter((n) => n.kind === 'room');
  assert.ok(rooms.length > 0);
  for (const room of rooms) {
    for (const stepFree of [false, true]) {
      const route = router.findRoute(start, room.id, stepFree);
      assert.equal(route.found, true, `${room.id} (stepFree=${stepFree}): ${route.message}`);
      const points = route.legs.flatMap((leg) => leg.points);
      const inner = points.slice(1, -1).filter((p) => ROOM_KINDS.has(p.kind));
      assert.equal(inner.length, 0, `${room.id} (stepFree=${stepFree}) passes through ${inner.map((p) => p.nodeId)}`);
    }
  }
});

test('1310 (Plenary) to 1270 walks corridors only', () => {
  const route = loadRouter().findRoute('n-f1-r1310', 'n-f1-r1270', false);
  assert.equal(route.found, true, route.message);
  assert.equal(route.legs.length, 1);
  const points = route.legs[0].points;
  assert.equal(points[0].nodeId, 'n-f1-r1310');
  assert.equal(points[points.length - 1].nodeId, 'n-f1-r1270');
  for (const p of points.slice(1, -1)) {
    assert.ok(['hallway', 'door', 'stairs', 'elevator', 'entrance'].includes(p.kind),
      `1310 to 1270 passes through ${p.nodeId} (${p.kind})`);
  }
});
