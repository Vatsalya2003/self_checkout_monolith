'use strict';

const express = require('express');
const config = require('./config');
const db = require('./db/db');

/**
 * HTTP surface of the monolith. This layer does nothing but translate between
 * the wire contract in spec/self-checkout-openapi.yaml and the synchronous
 * calls in src/db/db.js — no business rules live here.
 */

// Maps a domain error code to the status code the spec assigns it.
const ERROR_STATUS = {
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  UNKNOWN_SKU: 404,
  TRANSACTION_NOT_OPEN: 409,
  EMPTY_BASKET: 409,
};

function sendError(res, error, message) {
  res.status(ERROR_STATUS[error] || 500).json({ error, message });
}

function buildApp() {
  const app = express();
  app.disable('x-powered-by');
  // Baskets are at most 20 line items, so the default 100kb limit is plenty.
  app.use(express.json({ limit: '64kb' }));

  // GET /items — full catalog. The load client calls this once at startup.
  app.get('/items', (req, res) => {
    res.json({ items: db.listCatalog() });
  });

  // POST /transactions — start a transaction at a station.
  app.post('/transactions', (req, res) => {
    const stationId = req.body?.stationId;
    if (typeof stationId !== 'string' || stationId.trim() === '') {
      return sendError(res, 'INVALID_REQUEST', 'stationId is required and must be a non-empty string.');
    }
    res.status(201).json(db.startTransaction(stationId));
  });

  // POST /transactions/{id}/items — scan exactly one unit into the basket.
  app.post('/transactions/:transactionId/items', (req, res) => {
    const sku = req.body?.sku;
    if (typeof sku !== 'string' || sku.trim() === '') {
      return sendError(res, 'INVALID_REQUEST', 'sku is required and must be a non-empty string.');
    }
    const result = db.scanItem(req.params.transactionId, sku);
    if (result.error) return sendError(res, result.error, result.message);
    res.json(result.ok);
  });

  // POST /transactions/{id}/complete — pay, decrement stock, return a receipt.
  app.post('/transactions/:transactionId/complete', (req, res) => {
    const result = db.completeTransaction(req.params.transactionId);
    if (result.error) return sendError(res, result.error, result.message);
    res.json(result.ok);
  });

  // GET /transactions/{id} — status, for debugging / instructor use.
  app.get('/transactions/:transactionId', (req, res) => {
    const transaction = db.getTransaction(req.params.transactionId);
    if (!transaction) {
      return sendError(res, 'NOT_FOUND', `Transaction ${req.params.transactionId} was not found.`);
    }
    res.json(transaction);
  });

  // GET /inventory/low-stock — current alerts, with optional threshold override.
  app.get('/inventory/low-stock', (req, res) => {
    let threshold;
    if (req.query.threshold !== undefined) {
      threshold = Number.parseInt(req.query.threshold, 10);
      if (!Number.isFinite(threshold) || threshold < 0) {
        return sendError(res, 'INVALID_REQUEST', 'threshold must be a non-negative integer.');
      }
    }
    res.json(db.lowStock(threshold));
  });

  // GET /analytics/popular-items — most-scanned items in the current window.
  app.get('/analytics/popular-items', (req, res) => {
    let limit = 10;
    if (req.query.limit !== undefined) {
      limit = Number.parseInt(req.query.limit, 10);
      if (!Number.isFinite(limit) || limit < 1) {
        return sendError(res, 'INVALID_REQUEST', 'limit must be a positive integer.');
      }
    }
    res.json(db.popularItems(limit));
  });

  app.use((req, res) => {
    sendError(res, 'NOT_FOUND', `No route for ${req.method} ${req.path}.`);
  });

  // Express needs the 4-arg signature to recognise this as an error handler.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
      return sendError(res, 'INVALID_REQUEST', 'Request body must be valid JSON.');
    }
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Unexpected server error.' });
  });

  return app;
}

function main() {
  db.open();
  const app = buildApp();
  const server = app.listen(config.port, () => {
    console.log(`Self-checkout monolith listening on port ${config.port}`);
    console.log(
      `  catalogSize=${config.catalogSize} stockPerItem=${config.stockPerItem} ` +
        `lowStockThreshold=${config.lowStockThreshold}`
    );
    console.log(
      `  popularWindowSize=${config.popularWindowSize} popularSlideInterval=${config.popularSlideInterval}`
    );
    console.log(`  db=${config.dbFile} (reset on start: ${config.resetOnStart})`);
  });

  // Keep sockets alive between requests; the load client reuses connections and
  // the default 5s idle timeout would otherwise churn them under a long run.
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = { buildApp };
