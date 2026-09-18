-- Single schema for the whole monolith. Every module in the process talks to
-- these tables directly; there is no service boundary and no second datastore.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS items (
  sku            TEXT    PRIMARY KEY,
  name           TEXT    NOT NULL,
  -- Money is stored in integer cents. Storing it as REAL would let repeated
  -- running-total additions drift, and the receipt total is asserted against
  -- the client's own view of the basket.
  price_cents    INTEGER NOT NULL,
  stock          INTEGER NOT NULL CHECK (stock >= 0),
  initial_stock  INTEGER NOT NULL,
  catalog_rank   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  transaction_id      TEXT    PRIMARY KEY,
  station_id          TEXT    NOT NULL,
  status              TEXT    NOT NULL CHECK (status IN ('OPEN', 'COMPLETED', 'CANCELLED')),
  item_count          INTEGER NOT NULL DEFAULT 0,
  running_total_cents INTEGER NOT NULL DEFAULT 0,
  started_at          TEXT    NOT NULL,
  completed_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);

-- One row per (transaction, SKU). `quantity` is how many units the customer
-- scanned. `applied_quantity` is how many units were actually subtracted from
-- stock at completion time, and is NULL until the transaction completes.
-- The two differ only when a SKU sells out mid-run (see README, "Sold-out
-- SKUs and the stock invariant").
CREATE TABLE IF NOT EXISTS transaction_items (
  transaction_id   TEXT    NOT NULL,
  sku              TEXT    NOT NULL,
  quantity         INTEGER NOT NULL DEFAULT 0,
  applied_quantity INTEGER,
  PRIMARY KEY (transaction_id, sku),
  FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id),
  FOREIGN KEY (sku) REFERENCES items(sku)
);

CREATE INDEX IF NOT EXISTS idx_transaction_items_sku ON transaction_items(sku);

-- Append-only log of low-stock crossings: one row the moment a SKU's stock
-- first falls below the configured threshold.
CREATE TABLE IF NOT EXISTS low_stock_alerts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sku           TEXT    NOT NULL,
  current_stock INTEGER NOT NULL,
  threshold     INTEGER NOT NULL,
  triggered_at  TEXT    NOT NULL,
  FOREIGN KEY (sku) REFERENCES items(sku)
);

CREATE INDEX IF NOT EXISTS idx_low_stock_alerts_sku ON low_stock_alerts(sku);

-- Append-only log of individual scans. `seq` is the global scan sequence
-- number the popular-items window is defined over.
CREATE TABLE IF NOT EXISTS scan_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT NOT NULL,
  FOREIGN KEY (sku) REFERENCES items(sku)
);

-- The most recently computed hopping-window snapshot. Exactly one row.
CREATE TABLE IF NOT EXISTS popular_window (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  window_size   INTEGER NOT NULL,
  slide_interval INTEGER NOT NULL,
  window_start  INTEGER NOT NULL,
  window_end    INTEGER NOT NULL,
  computed_at   TEXT    NOT NULL
);

-- The ranked contents of that snapshot.
CREATE TABLE IF NOT EXISTS popular_window_items (
  rank       INTEGER PRIMARY KEY,
  sku        TEXT    NOT NULL,
  scan_count INTEGER NOT NULL
);
