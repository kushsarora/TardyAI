// Offline harness for src/NavRouter.js: evaluates the real, unmodified file in
// a fresh `vm` context whose only platform globals (MapNode, NavEdge, Filter)
// are stubs fed from data/. Not a *.test.js file, so `node --test` skips it.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PKG_DIR = path.resolve(__dirname, '..', '..');
const ROUTER_FILE = path.join(PKG_DIR, 'src', 'NavRouter.js');
const DATA_DIR = path.join(PKG_DIR, 'data');

function readJsonArray(relPath) {
  const file = path.join(DATA_DIR, relPath);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${file}: expected a JSON array`);
  return parsed;
}

/**
 * Load the seed graph from data/, with each node's `floor` replaced by its
 * full Floor row (id, level, name, pixelsPerMeter, building) — the shape C3's
 * `include: 'floor.level, ...'` hands to the router.
 *
 * Returns fresh objects on every call, so callers may mutate them freely.
 * Throws if a file is missing, is not a JSON array, or a node names a floor
 * that does not exist.
 */
function seed() {
  const floors = readJsonArray('Floor/Floor.json');
  const floorsById = new Map(floors.map((f) => [f.id, f]));
  const nodes = readJsonArray('MapNode/MapNode.json').map((n) => {
    const floor = floorsById.get(n.floor && n.floor.id);
    if (!floor) throw new Error(`node ${n.id}: unknown floor ${JSON.stringify(n.floor)}`);
    return { ...n, floor: structuredClone(floor) };
  });
  const edges = readJsonArray('NavEdge/NavEdge.json');
  return { floors, nodes, edges };
}

/** Read a dotted path ('floor.building.id') off an object; undefined if absent. */
function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// The only filter paths NavRouter.js uses today. Anything else throws, so a
// router change that queries a new path fails loudly instead of matching nothing.
const NODE_PATHS = new Set(['id', 'floor.id', 'floor.building.id']);
const EDGE_PATHS = new Set(['fromNode.floor.building.id']);

function makeFetch(typeName, rows, allowedPaths, resolveRow) {
  return function fetch(spec) {
    if (!spec || !spec.filter || typeof spec.filter.path !== 'string') {
      throw new Error(`${typeName}.fetch: expected a Filter.eq(...) filter, got ${JSON.stringify(spec)}`);
    }
    const { path: p, value } = spec.filter;
    if (!allowedPaths.has(p)) {
      throw new Error(`${typeName}.fetch: stub does not support filter path '${p}'`);
    }
    if (!Number.isInteger(spec.limit) || spec.limit === 0 || spec.limit < -1) {
      throw new Error(`${typeName}.fetch: bad limit ${spec.limit}`);
    }
    let objs = rows.filter((r) => getPath(resolveRow(r), p) === value);
    if (spec.limit > 0) objs = objs.slice(0, spec.limit);
    return { objs: structuredClone(objs) };
  };
}

/**
 * Evaluate NavRouter.js in a new vm context backed by `data` (default: seed()).
 *
 * Returns the context; every top-level router function is a property of it
 * (ctx.findRoute, ctx.routeToRoom, ctx.searchRooms, ...). Each call builds a
 * fresh context, so no state is shared between tests.
 *
 * Throws if NavRouter.js cannot be read or evaluated. The stubbed fetches
 * throw on an unsupported filter path, a bad limit, or an edge whose
 * fromNode is not in `data.nodes`.
 */
function loadRouter(data = seed()) {
  const nodes = structuredClone(data.nodes);
  const edges = structuredClone(data.edges);
  const nodesById = new Map(nodes.map((n) => [n.id, n]));

  const resolveEdge = (e) => {
    const from = nodesById.get(e.fromNode && e.fromNode.id);
    if (!from) throw new Error(`edge ${e.id}: fromNode ${JSON.stringify(e.fromNode)} is not a known node`);
    return { ...e, fromNode: from };
  };

  const ctx = vm.createContext({
    MapNode: { fetch: makeFetch('MapNode', nodes, NODE_PATHS, (n) => n) },
    NavEdge: { fetch: makeFetch('NavEdge', edges, EDGE_PATHS, resolveEdge) },
    Filter: { eq: (p, value) => ({ path: p, value }) },
  });
  vm.runInContext(fs.readFileSync(ROUTER_FILE, 'utf8'), ctx, { filename: ROUTER_FILE });
  return ctx;
}

module.exports = { seed, loadRouter };
