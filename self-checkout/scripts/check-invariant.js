#!/usr/bin/env node
'use strict';

/**
 * Correctness check, run against the database file *after* a load test and
 * independently of whatever the load client reported about itself.
 *
 * Asserts the two properties the spec calls out:
 *   1. No SKU's stock is negative.
 *   2. For every SKU: initial_stock - stock == the total stock actually
 *      decremented by COMPLETED transactions for that SKU.
 *
 * Property 2 is checked against `applied_quantity`, not `quantity`. The two are
 * identical for every SKU that never sold out; where a SKU did sell out they
 * differ by exactly the units that could not be decremented without taking
 * stock negative, and those are reported separately below.
 *
 * Usage: node scripts/check-invariant.js [path/to/self_checkout.db]
 */

const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const dbFile = process.argv[2] || path.join(__dirname, '..', 'data', 'self_checkout.db');
if (!fs.existsSync(dbFile)) {
  console.error(`No database at ${dbFile}`);
  process.exit(2);
}

const db = new Database(dbFile, { readonly: true });

const negativeStock = db
  .prepare('SELECT sku, stock FROM items WHERE stock < 0')
  .all();

const mismatches = db
  .prepare(
    `SELECT i.sku,
            i.initial_stock,
            i.stock,
            i.initial_stock - i.stock                AS actual_decrement,
            COALESCE(SUM(ti.applied_quantity), 0)    AS expected_decrement
     FROM items i
     LEFT JOIN transaction_items ti ON ti.sku = i.sku
     LEFT JOIN transactions t       ON t.transaction_id = ti.transaction_id
                                   AND t.status = 'COMPLETED'
     WHERE t.transaction_id IS NOT NULL OR ti.sku IS NULL
     GROUP BY i.sku
     HAVING actual_decrement <> expected_decrement`
  )
  .all();

const soldOut = db
  .prepare(
    `SELECT i.sku, i.stock,
            SUM(ti.quantity)          AS units_scanned,
            SUM(ti.applied_quantity)  AS units_decremented
     FROM items i
     JOIN transaction_items ti ON ti.sku = i.sku
     JOIN transactions t       ON t.transaction_id = ti.transaction_id AND t.status = 'COMPLETED'
     GROUP BY i.sku
     HAVING units_scanned <> units_decremented
     ORDER BY (units_scanned - units_decremented) DESC`
  )
  .all();

const totals = db
  .prepare(
    `SELECT
       (SELECT COUNT(*) FROM transactions)                                AS transactions_total,
       (SELECT COUNT(*) FROM transactions WHERE status = 'COMPLETED')     AS transactions_completed,
       (SELECT COUNT(*) FROM transactions WHERE status = 'OPEN')          AS transactions_open,
       (SELECT COUNT(*) FROM scan_events)                                 AS scans_total,
       (SELECT COUNT(*) FROM items)                                       AS items_total,
       (SELECT COUNT(*) FROM items WHERE stock = 0)                       AS items_sold_out`
  )
  .get();

console.log('=============== STOCK INVARIANT CHECK ===============');
console.log(`Database:              ${dbFile}`);
console.log(`Catalog SKUs:          ${totals.items_total}`);
console.log(`Transactions:          ${totals.transactions_total} ` +
            `(${totals.transactions_completed} completed, ${totals.transactions_open} left open)`);
console.log(`Scans recorded:        ${totals.scans_total}`);
console.log(`SKUs at zero stock:    ${totals.items_sold_out}`);
console.log('');
console.log(`1. No negative stock:  ${negativeStock.length === 0 ? 'PASS' : 'FAIL'}`);
if (negativeStock.length > 0) {
  for (const row of negativeStock.slice(0, 20)) {
    console.log(`     ${row.sku} stock=${row.stock}`);
  }
}

console.log(`2. Decrement balance:  ${mismatches.length === 0 ? 'PASS' : 'FAIL'}`);
if (mismatches.length > 0) {
  console.log('     sku            initial   final   actual_dec   expected_dec');
  for (const row of mismatches.slice(0, 20)) {
    console.log(
      `     ${row.sku.padEnd(14)} ${String(row.initial_stock).padStart(7)} ` +
        `${String(row.stock).padStart(7)} ${String(row.actual_decrement).padStart(12)} ` +
        `${String(row.expected_decrement).padStart(14)}`
    );
  }
}

console.log('');
if (soldOut.length === 0) {
  console.log('No SKU sold out mid-run: scanned units == decremented units for every SKU.');
} else {
  console.log(`${soldOut.length} SKU(s) sold out mid-run (scanned > decremented, stock floored at 0):`);
  console.log('     sku            scanned   decremented   unfilled');
  for (const row of soldOut.slice(0, 25)) {
    const unfilled = row.units_scanned - row.units_decremented;
    console.log(
      `     ${row.sku.padEnd(14)} ${String(row.units_scanned).padStart(7)} ` +
        `${String(row.units_decremented).padStart(13)} ${String(unfilled).padStart(10)}`
    );
  }
}
console.log('=====================================================');

db.close();

const failed = negativeStock.length > 0 || mismatches.length > 0;
process.exit(failed ? 1 : 0);
