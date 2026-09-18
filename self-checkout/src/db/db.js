'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const config = require('../config');

/**
 * The monolith's entire data layer and its business rules.
 *
 * Everything here is *synchronous*. better-sqlite3 blocks the Node event loop
 * for the duration of each call, which means a `db.transaction(...)` wrapper
 * runs start-to-finish with no other request interleaved: there is exactly one
 * thread of execution and exactly one connection. That is what makes the stock
 * invariant hold under load without any explicit locking — see ARCHITECTURE.md.
 */

let db;

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * Deterministic catalog, matching the course mock server's generator so that
 * reports from the two are directly comparable (same SKUs, names and prices).
 */
function seedCatalog(database) {
  const insert = database.prepare(
    'INSERT INTO items (sku, name, price_cents, stock, initial_stock, catalog_rank) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertMany = database.transaction((count) => {
    for (let i = 1; i <= count; i++) {
      const sku = `SKU-${String(i).padStart(6, '0')}`;
      // Mirrors MockServer: price = 0.5 + (i % 47) * 0.35, rounded to 2dp.
      const priceCents = Math.round((0.5 + (i % 47) * 0.35) * 100);
      insert.run(sku, `Item ${i}`, priceCents, config.stockPerItem, config.stockPerItem, i);
    }
  });
  insertMany(config.catalogSize);
}

function open() {
  const dir = path.dirname(config.dbFile);
  fs.mkdirSync(dir, { recursive: true });

  if (config.resetOnStart) {
    // Drop the previous run's data so every load test starts from a known
    // initial stock level. WAL sidecar files must go too, or stale pages from
    // the old database get replayed into the new one.
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(config.dbFile + suffix, { force: true });
    }
  }

  db = new Database(config.dbFile);

  // WAL plus NORMAL sync is the standard durability/throughput trade-off for a
  // single-writer embedded database: commits do not fsync on every write, but
  // the write-ahead log still survives a process crash.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

  const existing = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
  if (existing === 0) seedCatalog(db);

  prepareStatements();
  loadScanCounter();

  // Wrap the two mutating operations in SQLite transactions exactly once.
  scanItem = db.transaction(scanItemTx);
  completeTransaction = db.transaction(completeTransactionTx);

  return db;
}

// Assigned by open(); each is its raw *Tx function wrapped in db.transaction().
let scanItem;
let completeTransaction;

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

let stmt;

function prepareStatements() {
  stmt = {
    listCatalog: db.prepare('SELECT sku, name, price_cents FROM items ORDER BY catalog_rank'),
    getItem: db.prepare('SELECT sku, name, price_cents, stock FROM items WHERE sku = ?'),

    insertTransaction: db.prepare(
      `INSERT INTO transactions (transaction_id, station_id, status, item_count, running_total_cents, started_at)
       VALUES (?, ?, 'OPEN', 0, 0, ?)`
    ),
    getTransaction: db.prepare(
      `SELECT transaction_id, station_id, status, item_count, running_total_cents, started_at, completed_at
       FROM transactions WHERE transaction_id = ?`
    ),
    bumpTransaction: db.prepare(
      `UPDATE transactions
       SET item_count = item_count + 1, running_total_cents = running_total_cents + ?
       WHERE transaction_id = ?`
    ),
    completeTransaction: db.prepare(
      `UPDATE transactions SET status = 'COMPLETED', completed_at = ? WHERE transaction_id = ?`
    ),

    upsertLine: db.prepare(
      `INSERT INTO transaction_items (transaction_id, sku, quantity) VALUES (?, ?, 1)
       ON CONFLICT(transaction_id, sku) DO UPDATE SET quantity = quantity + 1`
    ),
    getLines: db.prepare(
      `SELECT ti.sku, ti.quantity, i.name, i.price_cents, i.stock
       FROM transaction_items ti JOIN items i ON i.sku = ti.sku
       WHERE ti.transaction_id = ?
       ORDER BY i.catalog_rank`
    ),
    setApplied: db.prepare(
      'UPDATE transaction_items SET applied_quantity = ? WHERE transaction_id = ? AND sku = ?'
    ),

    decrementStock: db.prepare('UPDATE items SET stock = stock - ? WHERE sku = ?'),
    insertAlert: db.prepare(
      'INSERT INTO low_stock_alerts (sku, current_stock, threshold, triggered_at) VALUES (?, ?, ?, ?)'
    ),
    lowStock: db.prepare(
      `SELECT i.sku, i.name, i.stock AS current_stock,
              (SELECT MIN(a.triggered_at) FROM low_stock_alerts a WHERE a.sku = i.sku) AS triggered_at
       FROM items i
       WHERE i.stock < ?
       ORDER BY i.stock ASC, i.catalog_rank ASC`
    ),

    insertScan: db.prepare('INSERT INTO scan_events (seq, sku) VALUES (?, ?)'),
    maxScanSeq: db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM scan_events'),
    windowCounts: db.prepare(
      `SELECT sku, COUNT(*) AS scan_count FROM scan_events
       WHERE seq > ? AND seq <= ?
       GROUP BY sku
       ORDER BY scan_count DESC, sku ASC`
    ),

    clearWindowItems: db.prepare('DELETE FROM popular_window_items'),
    insertWindowItem: db.prepare(
      'INSERT INTO popular_window_items (rank, sku, scan_count) VALUES (?, ?, ?)'
    ),
    upsertWindow: db.prepare(
      `INSERT INTO popular_window (id, window_size, slide_interval, window_start, window_end, computed_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         window_size = excluded.window_size,
         slide_interval = excluded.slide_interval,
         window_start = excluded.window_start,
         window_end = excluded.window_end,
         computed_at = excluded.computed_at`
    ),
    getWindow: db.prepare('SELECT * FROM popular_window WHERE id = 1'),
    getWindowItems: db.prepare(
      `SELECT p.rank, p.sku, p.scan_count, i.name
       FROM popular_window_items p JOIN items i ON i.sku = p.sku
       ORDER BY p.rank LIMIT ?`
    ),
  };
}

// ---------------------------------------------------------------------------
// In-process counters
// ---------------------------------------------------------------------------

// The global scan sequence number the popular-items window is defined over.
// Held in memory (and persisted on every scan via scan_events.seq) so that the
// hot path never needs a MAX() lookup.
let scanCounter = 0;
let transactionCounter = 0;

function loadScanCounter() {
  scanCounter = stmt.maxScanSeq.get().seq;
}

function centsToDollars(cents) {
  return Math.round(cents) / 100;
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

function listCatalog() {
  return stmt.listCatalog.all().map((row) => ({
    sku: row.sku,
    name: row.name,
    price: centsToDollars(row.price_cents),
  }));
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

function toTransactionView(row) {
  return {
    transactionId: row.transaction_id,
    stationId: row.station_id,
    status: row.status,
    itemCount: row.item_count,
    runningTotal: centsToDollars(row.running_total_cents),
    startedAt: row.started_at,
  };
}

function startTransaction(stationId) {
  const startedAt = nowIso();
  // Process-local counter + pid keeps ids unique without a round trip, and
  // keeps them short enough to stay readable in logs.
  const transactionId = `tx-${process.pid}-${++transactionCounter}`;
  stmt.insertTransaction.run(transactionId, stationId, startedAt);
  return {
    transactionId,
    stationId,
    status: 'OPEN',
    itemCount: 0,
    runningTotal: 0,
    startedAt,
  };
}

function getTransaction(transactionId) {
  const row = stmt.getTransaction.get(transactionId);
  return row ? toTransactionView(row) : null;
}

/**
 * Scan exactly one unit of `sku` into `transactionId`.
 *
 * Wrapped in a single SQLite transaction: the basket line, the transaction
 * totals and the analytics scan log either all move forward together or not at
 * all, so a crash mid-scan cannot leave a basket whose itemCount disagrees with
 * its line items.
 */
const scanItemTx = (transactionId, sku) => {
  const tx = stmt.getTransaction.get(transactionId);
  if (!tx) return { error: 'NOT_FOUND', message: `Transaction ${transactionId} was not found.` };
  if (tx.status !== 'OPEN') {
    return {
      error: 'TRANSACTION_NOT_OPEN',
      message: `Transaction ${transactionId} is ${tx.status.toLowerCase()}.`,
    };
  }

  const item = stmt.getItem.get(sku);
  if (!item) return { error: 'UNKNOWN_SKU', message: `SKU ${sku} is not in the catalog.` };

  stmt.upsertLine.run(transactionId, sku);
  stmt.bumpTransaction.run(item.price_cents, transactionId);

  // Stock is deliberately NOT touched here. The customer already has the item
  // in hand; the decrement happens at completion (see the spec's domain model).
  const seq = ++scanCounter;
  stmt.insertScan.run(seq, sku);
  maybeRecomputePopularWindow(seq);

  return {
    ok: {
      transactionId,
      sku: item.sku,
      name: item.name,
      unitPrice: centsToDollars(item.price_cents),
      itemCount: tx.item_count + 1,
      runningTotal: centsToDollars(tx.running_total_cents + item.price_cents),
    },
  };
};

/**
 * Complete a transaction: decrement stock once per scanned unit, raise any
 * low-stock alerts, and return the receipt.
 *
 * The read of `stock`, the decision about how much to decrement, and the write
 * all happen inside one SQLite transaction on one connection in one thread, so
 * no other request can observe or modify the same row in between. This is the
 * check-then-decrement step the assignment is built around.
 */
const completeTransactionTx = (transactionId) => {
  const tx = stmt.getTransaction.get(transactionId);
  if (!tx) return { error: 'NOT_FOUND', message: `Transaction ${transactionId} was not found.` };
  if (tx.status !== 'OPEN') {
    return {
      error: 'TRANSACTION_NOT_OPEN',
      message: `Transaction ${transactionId} is already ${tx.status.toLowerCase()}.`,
    };
  }

  const lines = stmt.getLines.all(transactionId);
  if (lines.length === 0) {
    return { error: 'EMPTY_BASKET', message: `Transaction ${transactionId} has no scanned items.` };
  }

  const completedAt = nowIso();
  const threshold = config.lowStockThreshold;
  let totalCents = 0;
  const receiptLines = [];

  for (const line of lines) {
    // Clamp rather than go negative. `applied` is recorded so the stock
    // invariant stays checkable even for SKUs that sell out mid-run.
    const applied = Math.min(line.quantity, line.stock);
    if (applied > 0) stmt.decrementStock.run(applied, line.sku);
    stmt.setApplied.run(applied, transactionId, line.sku);

    const newStock = line.stock - applied;
    if (line.stock >= threshold && newStock < threshold) {
      stmt.insertAlert.run(line.sku, newStock, threshold, completedAt);
    }

    totalCents += line.price_cents * line.quantity;
    receiptLines.push({
      sku: line.sku,
      name: line.name,
      unitPrice: centsToDollars(line.price_cents),
      quantity: line.quantity,
    });
  }

  stmt.completeTransaction.run(completedAt, transactionId);

  return {
    ok: {
      transactionId,
      stationId: tx.station_id,
      itemCount: tx.item_count,
      totalAmount: centsToDollars(totalCents),
      startedAt: tx.started_at,
      completedAt,
      lines: receiptLines,
    },
  };
};

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

function lowStock(thresholdOverride) {
  const threshold = thresholdOverride ?? config.lowStockThreshold;
  const generatedAt = nowIso();
  const alerts = stmt.lowStock.all(threshold).map((row) => ({
    sku: row.sku,
    name: row.name,
    currentStock: row.current_stock,
    threshold,
    // For an ad-hoc threshold override there is no recorded crossing, so fall
    // back to the time this response was generated.
    triggeredAt: row.triggered_at || generatedAt,
  }));
  return { threshold, generatedAt, alerts };
}

// ---------------------------------------------------------------------------
// Analytics — hopping window over the most recent scans
// ---------------------------------------------------------------------------

function recomputePopularWindow(endSeq) {
  const windowStart = Math.max(0, endSeq - config.popularWindowSize);
  const rows = stmt.windowCounts.all(windowStart, endSeq);

  stmt.clearWindowItems.run();
  rows.forEach((row, index) => {
    stmt.insertWindowItem.run(index + 1, row.sku, row.scan_count);
  });
  stmt.upsertWindow.run(
    config.popularWindowSize,
    config.popularSlideInterval,
    windowStart,
    endSeq,
    nowIso()
  );
}

/**
 * Hopping (not continuously sliding) window: the ranking is recomputed only
 * once every `popularSlideInterval` scans, and each recomputation looks back
 * over the last `popularWindowSize` scans. Between recomputations the endpoint
 * keeps serving the last snapshot, which is what makes this cheap on the hot
 * path.
 */
function maybeRecomputePopularWindow(seq) {
  if (seq % config.popularSlideInterval === 0) {
    recomputePopularWindow(seq);
  }
}

function popularItems(limit) {
  let window = stmt.getWindow.get();
  if (!window) {
    // Bootstrap: fewer than one full slide interval of scans has happened, so
    // no snapshot exists yet. Compute one on demand so the endpoint is still
    // meaningful during short smoke tests.
    recomputePopularWindow(scanCounter);
    window = stmt.getWindow.get();
  }

  const items = stmt.getWindowItems.all(limit).map((row) => ({
    sku: row.sku,
    name: row.name,
    scanCount: row.scan_count,
    rank: row.rank,
  }));

  return {
    windowSize: window.window_size,
    slideInterval: window.slide_interval,
    windowStart: window.window_start,
    windowEnd: window.window_end,
    computedAt: window.computed_at,
    items,
  };
}

// ---------------------------------------------------------------------------

function close() {
  if (db) db.close();
}

module.exports = {
  open,
  close,
  getDb: () => db,
  listCatalog,
  startTransaction,
  getTransaction,
  lowStock,
  popularItems,
  // Thin delegates: the db.transaction(...) wrappers are built once in open(),
  // not rebuilt per call, since these two are the hot path.
  scanItem: (transactionId, sku) => scanItem(transactionId, sku),
  completeTransaction: (transactionId) => completeTransaction(transactionId),
};
