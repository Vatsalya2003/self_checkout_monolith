# Self-Checkout — Week 1: Monolith

An implementation of the shared CS6510 self-checkout API contract
(`spec/self-checkout-openapi.yaml`) as a **single-process monolith**:
one Node.js process, one Express app, one embedded SQLite database.

Every subsequent week re-implements this same contract in a different
architecture style. Nothing about the contract changes — only what is behind it.

## Requirements

- Node.js 20+ (developed on 22.8.0)
- No external database, broker, or service — the entire system is this one process

## Install and run

```bash
npm install
npm start
```

The server listens on port 8080 by default and prints its effective
configuration on startup.

### Configuration

All values are environment variables with defaults chosen to match the course
mock server (`mockserver/run.sh 8080 2000 10000 50`), so reports are directly
comparable.

| Variable                 | Default | Meaning                                              |
| ------------------------ | ------- | ---------------------------------------------------- |
| `PORT`                   | `8080`  | HTTP port                                            |
| `CATALOG_SIZE`           | `2000`  | Number of SKUs seeded into the catalog               |
| `STOCK_PER_ITEM`         | `10000` | Starting stock for every SKU                         |
| `LOW_STOCK_THRESHOLD`    | `50`    | Stock level below which a low-stock alert is raised  |
| `POPULAR_WINDOW_SIZE`    | `1000`  | Scans considered by the popular-items window         |
| `POPULAR_SLIDE_INTERVAL` | `500`   | How often (in scans) that window is recomputed       |
| `DB_FILE`                | `data/self_checkout.db` | SQLite database file                 |
| `RESET_ON_START`         | `true`  | Wipe and reseed the database on every boot           |

**The database is wiped and reseeded on every server start.** There is no
manual reset step between load-test runs — just restart the process.

## Layout

```
src/
├── server.js        HTTP routes; translates the wire contract to/from the data layer
├── config.js        Environment-variable configuration
└── db/
    ├── schema.sql   The single schema shared by every feature
    └── db.js        All business logic and persistence (synchronous)
scripts/
├── smoke-test.js      Asserts every endpoint against the OpenAPI contract
└── check-invariant.js Verifies the stock invariant after a load test
```

`src/db/db.js` holds the business rules; `src/server.js` holds no logic beyond
request validation and status-code mapping. That split is what makes next
week's layered version a refactor rather than a rewrite.

## Verifying it

With the server running:

```bash
npm run smoke     # 48 assertions covering every endpoint, field, and status code
npm run check     # stock invariant, run against the DB file after a load test
```

`smoke-test.js` checks the exact field names, shapes, and status codes in the
OpenAPI spec — including the error paths (400 on a missing `stationId`, 404 on
an unknown SKU or transaction, 409 on scanning or re-completing a finalized
transaction, 409 on completing an empty basket).

## Design notes

### Concurrency: why this is correct without locking

`better-sqlite3` is **synchronous**. Each call blocks the Node event loop until
SQLite returns. Combined with Node's single-threaded execution model, a
`db.transaction(...)` wrapper therefore runs start-to-finish with no other
request interleaved — there is exactly one thread of execution and exactly one
connection.

This matters at `completeTransactionTx` in `src/db/db.js`, where stock is read,
a decrement is decided, and the new value written. That read-decide-write
sequence is the check-then-decrement step the assignment is designed to break.
Here it cannot interleave, so no explicit locking, row versioning, or
compare-and-swap is required. The property is a consequence of the runtime
model, not of defensive code — which is precisely the trade-off examined in
`../ARCHITECTURE.md`.

### Money is stored in integer cents

`items.price_cents` is an INTEGER, and running totals accumulate in cents.
Storing prices as REAL and repeatedly adding them would let a basket's running
total drift from the client's own view of it. Dollar values are produced only at
the response boundary.

### Sold-out SKUs and the stock invariant

The load client samples items with a Zipf-like weighting, so the hottest SKU
receives roughly 12% of all scans. At the course's default stock level (10,000
units) the top SKU **sells out partway through even a 60-second run** — this is
observed behaviour, not a hypothetical.

That forces a decision the spec constrains but does not spell out. The spec says
stock must never go negative *and* that decrements must balance against starting
stock. Once a SKU is exhausted, a customer can still scan units of it (the spec
is explicit that scanning is never gated), so scanned units and decrementable
units genuinely diverge.

This implementation records both:

- `transaction_items.quantity` — units the customer scanned
- `transaction_items.applied_quantity` — units actually subtracted from stock

They are equal for every SKU that never sells out. Where a SKU does sell out,
the decrement is clamped at zero stock and `applied_quantity` records what was
really applied. The invariant is therefore stated against `applied_quantity`:

```sql
SELECT i.sku,
       i.initial_stock,
       i.stock,
       i.initial_stock - i.stock             AS actual_decrement,
       COALESCE(SUM(ti.applied_quantity), 0) AS expected_decrement
FROM items i
LEFT JOIN transaction_items ti ON ti.sku = i.sku
LEFT JOIN transactions t       ON t.transaction_id = ti.transaction_id
                              AND t.status = 'COMPLETED'
WHERE t.transaction_id IS NOT NULL OR ti.sku IS NULL
GROUP BY i.sku
HAVING actual_decrement <> expected_decrement;
```

Zero rows returned means the invariant holds. Plus the non-negativity check:

```sql
SELECT sku, stock FROM items WHERE stock < 0;
```

`npm run check` runs both, and additionally lists every SKU that sold out
mid-run with its scanned-vs-decremented counts, so the clamping is visible
rather than hidden.

> **Note on the course README's version of this query.** The course README
> phrases the invariant as `initial_stock - final_stock` == *the total number of
> completed-transaction line items* — i.e. against `quantity`. That formulation
> only holds while no SKU sells out. On a real 15-second run against this
> server it reported `SKU-000001: actual=10000, expected=10255` — a false
> failure, caused by 255 units scanned after the SKU was already exhausted.
> The `applied_quantity` form above is the same check, stated so it survives
> stock exhaustion.

### Popular items is a hopping window, not a sliding one

The ranking is recomputed once every `POPULAR_SLIDE_INTERVAL` scans, and each
recomputation looks back over the last `POPULAR_WINDOW_SIZE` scans. Between
recomputations the endpoint serves the last snapshot from
`popular_window_items`. This keeps the scan hot path at one extra INSERT, with
the aggregation amortized across 500 scans.

`scan_events` is the append-only log the window is computed over, and
`scan_events.seq` is the global scan sequence number reported as
`windowStart`/`windowEnd`.
