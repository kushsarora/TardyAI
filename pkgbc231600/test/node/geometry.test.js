'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { seed, loadRouter } = require('./harness');
// Interior rectangles transcribed independently from the plan rasters. These
// cover the reported failures and the central service/void blocks, not every
// wall in the building. They test geometry, rather than trusting node.kind.
const obstacles = require('./fixtures/route-obstacles.json');

function collisions(a, b, level) {
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
  for (let i = 0; i <= steps; i++) {
    const x = a.x + (b.x - a.x) * i / steps;
    const y = a.y + (b.y - a.y) * i / steps;
    for (const obstacle of obstacles[level] || []) {
      const [left, top, right, bottom] = obstacle.bounds;
      if (x > left && x < right && y > top && y < bottom) return obstacle.name;
    }
  }
  return null;
}

function checkRoute(route) {
  assert.equal(route.found, true, route.message);
  for (const leg of route.legs) {
    for (let i = 1; i < leg.points.length; i++) {
      const a = leg.points[i - 1], b = leg.points[i];
      assert.equal(collisions(a, b, leg.floorLevel), null,
        `${a.nodeId} -> ${b.nodeId} crosses a blocked interior`);
    }
  }
}

test('all graph edges avoid independently mapped classroom, service and void interiors', () => {
  const { nodes, edges } = seed();
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const edge of edges) {
    const a = byId.get(edge.fromNode.id), b = byId.get(edge.toNode.id);
    const blocked = collisions({ x: a.imageX, y: a.imageY }, { x: b.imageX, y: b.imageY }, a.floor.level);
    assert.equal(blocked, null, `${edge.id} crosses ${blocked}`);
  }
});

test('reported routes use access points and avoid classroom and restroom shortcuts, in both directions', () => {
  const router = loadRouter();
  for (const [a, b] of [['n-f1-r1210B', 'n-f1-r1270'], ['n-f1-r1270', 'n-f3-r3210H']]) {
    for (const stepFree of [false, true]) for (const [start, end] of [[a, b], [b, a]]) {
      const route = router.findRoute(start, end, stepFree);
      checkRoute(route);
      if (stepFree) assert.ok(route.legs.every(leg => leg.points.every(p => p.kind !== 'stairs')));
      if (end.endsWith('3210H')) {
        const finalLeg = route.legs.at(-1);
        assert.ok(finalLeg.points.some(p => p.nodeId.includes('commons')), 'must enter Learning Commons through its own circulation');
      }
    }
  }
});

test('rooms terminate at their corridor access point, preserving independent label positions', () => {
  const { nodes, edges } = seed(); const byId = new Map(nodes.map(n => [n.id, n]));
  for (const room of nodes.filter(n => n.kind === 'room' || n.kind === 'restroom')) {
    const edge = edges.find(e => e.fromNode.id === room.id);
    const door = byId.get(edge.toNode.id);
    assert.equal(room.imageX, door.imageX, `${room.id}: route must stop before entering room`);
    assert.equal(room.imageY, door.imageY);
    assert.ok(Number.isFinite(room.labelX) && Number.isFinite(room.labelY));
  }
});

test('obstacle regression would reject the old direct 1210B line through the restroom island', () => {
  assert.ok(collisions({x:790,y:500}, {x:790,y:786}, 1));
  assert.ok(collisions({x:512,y:700}, {x:1000,y:700}, 3));
});

test('old seed shortcut edges cannot be reactivated by a C3 upsert', () => {
  const data = seed();
  const old = { id: 'legacy-wall-shortcut', fromNode: {id: 'n-f1-r1270'}, toNode: {id: 'n-f1-elev-commons'}, edgeType: 'hallway', seconds: 0.1, meters: 0, stepFree: true };
  data.edges.push(old);
  const clean = loadRouter().findRoute('n-f1-r1270', 'n-f3-r3210H', true);
  const mixed = loadRouter(data).findRoute('n-f1-r1270', 'n-f3-r3210H', true);
  assert.equal(mixed.totalSeconds, clean.totalSeconds);
  checkRoute(mixed);
});

test('room 3210H is searchable with preserved label coordinates and revised graph provenance', () => {
  const router = loadRouter();
  const rooms = router.searchRooms('grainger', '3210H', 8);
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].roomNumber, '3210H');
  assert.notEqual(rooms[0].imageY, rooms[0].labelY);
  assert.equal(router.graphForBuilding('grainger').routingRevision, 'grainger-access-v2');
});
