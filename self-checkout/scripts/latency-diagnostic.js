#!/usr/bin/env node
'use strict';

/**
 * Latency diagnostic harness — reproduces the tail-latency investigation cited
 * in ARCHITECTURE.md §2 ("Reading the numbers").
 *
 * Mounts the real Express app, unmodified, behind timing middleware so that
 * *server-side* handler latency can be compared against the load client's
 * reported max. Started under `--trace-gc`, it lets you check whether V8 GC
 * pauses or SQLite WAL checkpoints account for the client's outlier requests.
 *
 * Usage:
 *   node --trace-gc scripts/latency-diagnostic.js            # default pragmas
 *   WAL_AUTOCHECKPOINT=0  node --trace-gc scripts/...         # checkpoints off
 *   WAL_AUTOCHECKPOINT=50 node --trace-gc scripts/...         # 20x more often
 *
 * Then run the course load client against it as usual. Every request at or above
 * SLOW_MS (default 25) is logged as:
 *   SLOW <msSinceStart> <durationMs> <METHOD> <path>
 * `msSinceStart` is on the same clock as --trace-gc's own timestamps, so GC
 * pauses and slow requests can be correlated directly. A SUMMARY line prints
 * every 15s and on shutdown.
 */

const express = require('express');
const db = require('../src/db/db');
const { buildApp } = require('../src/server');
const config = require('../src/config');

const SLOW_MS = Number(process.env.SLOW_MS || 25);
const AUTOCHECKPOINT = process.env.WAL_AUTOCHECKPOINT;

db.open();
if (AUTOCHECKPOINT !== undefined) {
  db.getDb().pragma(`wal_autocheckpoint = ${Number(AUTOCHECKPOINT)}`);
}
console.log('journal_mode       =', db.getDb().pragma('journal_mode', { simple: true }));
console.log('synchronous        =', db.getDb().pragma('synchronous', { simple: true }));
console.log('wal_autocheckpoint =', db.getDb().pragma('wal_autocheckpoint', { simple: true }));
console.log(`logging requests >= ${SLOW_MS}ms`);

let requests = 0;
let max = 0;
let maxAt = 0;
let maxPath = '';
const thresholds = [10, 25, 50, 100, 200, 400];
const overThreshold = new Map(thresholds.map((t) => [t, 0]));

const outer = express();
outer.use((req, res, next) => {
  const startedAt = performance.now();
  res.on('finish', () => {
    const elapsed = performance.now() - startedAt;
    requests++;
    if (elapsed > max) {
      max = elapsed;
      maxAt = startedAt;
      maxPath = `${req.method} ${req.path}`;
    }
    for (const t of thresholds) {
      if (elapsed >= t) overThreshold.set(t, overThreshold.get(t) + 1);
    }
    if (elapsed >= SLOW_MS) {
      console.log(`SLOW ${startedAt.toFixed(0)} ${elapsed.toFixed(1)} ${req.method} ${req.path}`);
    }
  });
  next();
});
outer.use(buildApp());

function summary(label) {
  const counts = thresholds.map((t) => `>=${t}ms:${overThreshold.get(t)}`).join(' ');
  console.log(
    `SUMMARY[${label}] requests=${requests} serverMax=${max.toFixed(1)}ms ` +
      `at=${maxAt.toFixed(0)}ms (${maxPath}) ${counts}`
  );
}

const ticker = setInterval(() => summary('periodic'), 15000);
ticker.unref();

const server = outer.listen(config.port, () => {
  console.log(`latency diagnostic harness listening on port ${config.port}`);
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    summary('final');
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
}
