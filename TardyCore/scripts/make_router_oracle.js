// Generates TardyCore parity fixtures by running the original C3 NavRouter.js
// (via the C3 branch's offline test harness) on the Grainger seed data.
// Usage: node make_router_oracle.js <path-to-C3-pkgbc231600> <out.json>
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const [pkg, out] = process.argv.slice(2);
const { loadRouter } = require(path.join(path.resolve(pkg), 'test', 'node', 'harness.js'));
const router = loadRouter();
const nodes = JSON.parse(fs.readFileSync(path.join(pkg, 'data/MapNode/MapNode.json'), 'utf8'));
const places = nodes.filter((n) => ['room', 'restroom', 'entrance'].includes(n.kind));
const entrance = 'n-f1-entrance-w';

// Deterministic pseudo-random pairs (LCG) so the fixture is reproducible.
let seed = 8772;
const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
const pairs = [];
for (const p of places) if (p.id !== entrance) pairs.push([entrance, p.id]);
for (let i = 0; i < 160; i++) pairs.push([places[rand(places.length)].id, places[rand(places.length)].id]);
// Edge cases: connectors and hallways as endpoints, unknown ids, same node.
pairs.push(['n-f1-stair-w', 'n-f3-r3335'], ['n-f1-elev-wa', entrance], [entrance, entrance], [entrance, 'nope'], ['', entrance]);

const slim = (r) => ({
  found: r.found, message: r.message, totalSeconds: r.totalSeconds, totalMeters: r.totalMeters,
  floorsTraversed: r.floorsTraversed,
  legs: r.legs.map((l) => ({
    floorId: l.floorId, floorLevel: l.floorLevel, instruction: l.instruction,
    exitConnectorKey: l.exitConnectorKey, seconds: Math.round(l.seconds * 1000) / 1000,
    meters: Math.round(l.meters * 1000) / 1000,
    nodeIds: l.points.map((p) => p.nodeId),
    steps: l.steps.map((s) => ({ kind: s.kind, text: s.text, meters: s.meters, seconds: s.seconds, pointIndex: s.pointIndex })),
  })),
});
const routes = [];
for (const [a, b] of pairs) for (const stepFree of [false, true]) {
  routes.push({ start: a, dest: b, stepFree, route: slim(router.findRoute(a, b, stepFree)) });
}
const queries = ['3335', '33', 'learning', 'commons', 'restroom', 'bathroom', 'aud', '1100', 'entrance', '  ', 'zzz', '210', 'elevator', 'Stairs', 'B'];
const searches = queries.map((q) => ({ query: q, ids: router.searchRooms('grainger', q, 10).map((n) => n.id) }));
const nearest = [];
for (const f of ['grainger-f1', 'grainger-f2', 'grainger-f3'])
  for (let i = 0; i < 25; i++) { const x = rand(1980), y = rand(1530); nearest.push({ floorId: f, x, y, id: router.nearestNode(f, x, y).id }); }
fs.writeFileSync(out, JSON.stringify({ generatedFrom: 'C3 branch pkgbc231600/src/NavRouter.js', routes, searches, nearest }));
console.log(routes.length, 'routes,', routes.filter((r) => r.route.found).length, 'found;', searches.length, 'searches;', nearest.length, 'nearest');
