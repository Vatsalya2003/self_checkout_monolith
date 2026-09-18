'use strict';

/**
 * All tunables in one place. Every value can be overridden by an environment
 * variable so the same build can be pointed at the course's default workload
 * (2000 SKUs / 10000 units / threshold 50) or at a smaller one for smoke tests.
 */

function intFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  return parsed;
}

const config = {
  port: intFromEnv('PORT', 8080),

  // Catalog seeding. These defaults mirror the course mock server
  // (`mockserver/run.sh 8080 2000 10000 50`) so that reports are comparable.
  catalogSize: intFromEnv('CATALOG_SIZE', 2000),
  stockPerItem: intFromEnv('STOCK_PER_ITEM', 10000),
  lowStockThreshold: intFromEnv('LOW_STOCK_THRESHOLD', 50),

  // Hopping window for /analytics/popular-items: consider the most recent
  // POPULAR_WINDOW_SIZE scans, recomputed once every POPULAR_SLIDE_INTERVAL scans.
  popularWindowSize: intFromEnv('POPULAR_WINDOW_SIZE', 1000),
  popularSlideInterval: intFromEnv('POPULAR_SLIDE_INTERVAL', 500),

  dbFile: process.env.DB_FILE || require('node:path').join(__dirname, '..', 'data', 'self_checkout.db'),

  // The DB is wiped and reseeded on every boot so each load-test run starts
  // from a known initial stock level. Set to "false" to keep an existing file.
  resetOnStart: (process.env.RESET_ON_START || 'true') !== 'false',
};

module.exports = config;
