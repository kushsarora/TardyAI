// Runs the real, unmodified src/NavRouter.js on the seed data (via the node
// test harness) and prints its answer as JSON, so the Python Room Finder tests
// can check against the actual router instead of a hand-written stand-in.
//
// Usage: node router_oracle.js <startNodeId> <destNodeId> <true|false>
// Prints one NavRoute object on stdout. Exits 2 on bad usage; any router
// exception propagates (non-zero exit), so the caller fails loudly.
'use strict';

const path = require('node:path');
const { loadRouter } = require(path.join(__dirname, '..', 'node', 'harness.js'));

const [startNodeId, destNodeId, stepFreeArg] = process.argv.slice(2);
if (!startNodeId || !destNodeId || !['true', 'false'].includes(stepFreeArg)) {
  process.stderr.write('usage: node router_oracle.js <startNodeId> <destNodeId> <true|false>\n');
  process.exit(2);
}

const route = loadRouter().findRoute(startNodeId, destNodeId, stepFreeArg === 'true');
process.stdout.write(JSON.stringify(route));
