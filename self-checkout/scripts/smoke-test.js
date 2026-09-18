#!/usr/bin/env node
'use strict';

/**
 * Contract smoke test: exercises every endpoint in
 * spec/self-checkout-openapi.yaml against a running server and asserts the
 * exact status codes, field names and shapes the spec requires.
 *
 * Usage: node scripts/smoke-test.js [baseUrl]
 */

const baseUrl = (process.argv[2] || 'http://localhost:8080').replace(/\/$/, '');

let passed = 0;
const failures = [];

function check(label, condition, detail) {
  if (condition) {
    passed++;
  } else {
    failures.push(detail ? `${label} — ${detail}` : label);
  }
}

function hasKeys(obj, keys) {
  if (obj === null || typeof obj !== 'object') return false;
  return keys.every((k) => Object.prototype.hasOwnProperty.call(obj, k));
}

async function call(method, path, body) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: body === undefined ? { Accept: 'application/json' } : {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  return { status: res.status, json, text };
}

async function main() {
  // --- GET /items -------------------------------------------------------
  const items = await call('GET', '/items');
  check('GET /items -> 200', items.status === 200, `got ${items.status}`);
  check('GET /items has items[]', Array.isArray(items.json?.items));
  const catalog = items.json.items;
  check('catalog is non-empty', catalog.length > 0);
  check('CatalogItem has {sku,name,price}', hasKeys(catalog[0], ['sku', 'name', 'price']),
    JSON.stringify(catalog[0]));
  check('price is a number', typeof catalog[0].price === 'number');

  const skuA = catalog[0].sku;
  const skuB = catalog[1].sku;

  // --- POST /transactions ----------------------------------------------
  const started = await call('POST', '/transactions', { stationId: 'station-smoke' });
  check('POST /transactions -> 201', started.status === 201, `got ${started.status}`);
  check('Transaction has all required fields',
    hasKeys(started.json, ['transactionId', 'stationId', 'status', 'itemCount', 'runningTotal', 'startedAt']),
    JSON.stringify(started.json));
  check('new transaction status is OPEN', started.json?.status === 'OPEN');
  check('startedAt parses as a date-time', !Number.isNaN(Date.parse(started.json?.startedAt)));
  const txId = started.json.transactionId;

  const badStart = await call('POST', '/transactions', {});
  check('POST /transactions without stationId -> 400', badStart.status === 400, `got ${badStart.status}`);
  check('400 body is an ApiError', hasKeys(badStart.json, ['error', 'message']));

  // --- POST /transactions/{id}/items ------------------------------------
  const scan1 = await call('POST', `/transactions/${txId}/items`, { sku: skuA });
  check('POST scan -> 200', scan1.status === 200, `got ${scan1.status}`);
  check('ScanResult has all required fields',
    hasKeys(scan1.json, ['transactionId', 'sku', 'name', 'unitPrice', 'itemCount', 'runningTotal']),
    JSON.stringify(scan1.json));
  check('itemCount after 1 scan is 1', scan1.json?.itemCount === 1, `got ${scan1.json?.itemCount}`);

  const scan2 = await call('POST', `/transactions/${txId}/items`, { sku: skuA });
  check('scanning the same SKU twice counts 2 units', scan2.json?.itemCount === 2, `got ${scan2.json?.itemCount}`);
  const scan3 = await call('POST', `/transactions/${txId}/items`, { sku: skuB });
  check('itemCount after 3 scans is 3', scan3.json?.itemCount === 3, `got ${scan3.json?.itemCount}`);

  const expectedTotal = Math.round((catalog[0].price * 2 + catalog[1].price) * 100) / 100;
  check('runningTotal matches the basket', scan3.json?.runningTotal === expectedTotal,
    `got ${scan3.json?.runningTotal}, expected ${expectedTotal}`);

  const badSku = await call('POST', `/transactions/${txId}/items`, { sku: 'SKU-DOES-NOT-EXIST' });
  check('scan with unknown SKU -> 404', badSku.status === 404, `got ${badSku.status}`);
  const badTx = await call('POST', '/transactions/tx-does-not-exist/items', { sku: skuA });
  check('scan on unknown transaction -> 404', badTx.status === 404, `got ${badTx.status}`);

  // --- GET /transactions/{id} -------------------------------------------
  const status = await call('GET', `/transactions/${txId}`);
  check('GET transaction -> 200', status.status === 200, `got ${status.status}`);
  check('status is still OPEN before completion', status.json?.status === 'OPEN');
  check('itemCount is 3', status.json?.itemCount === 3, `got ${status.json?.itemCount}`);
  const missingTx = await call('GET', '/transactions/tx-does-not-exist');
  check('GET unknown transaction -> 404', missingTx.status === 404, `got ${missingTx.status}`);

  // --- POST /transactions/{id}/complete ---------------------------------
  const receipt = await call('POST', `/transactions/${txId}/complete`);
  check('POST complete -> 200', receipt.status === 200, `got ${receipt.status}`);
  check('Receipt has all required fields',
    hasKeys(receipt.json, ['transactionId', 'stationId', 'itemCount', 'totalAmount', 'startedAt', 'completedAt', 'lines']),
    JSON.stringify(receipt.json));
  check('receipt itemCount is 3', receipt.json?.itemCount === 3, `got ${receipt.json?.itemCount}`);
  check('receipt totalAmount matches', receipt.json?.totalAmount === expectedTotal,
    `got ${receipt.json?.totalAmount}`);
  check('receipt has 2 distinct lines', receipt.json?.lines?.length === 2, `got ${receipt.json?.lines?.length}`);
  check('ReceiptLine has {sku,name,unitPrice,quantity}',
    hasKeys(receipt.json?.lines?.[0], ['sku', 'name', 'unitPrice', 'quantity']),
    JSON.stringify(receipt.json?.lines?.[0]));
  const lineA = receipt.json.lines.find((l) => l.sku === skuA);
  check('the twice-scanned SKU has quantity 2', lineA?.quantity === 2, `got ${lineA?.quantity}`);

  const reComplete = await call('POST', `/transactions/${txId}/complete`);
  check('completing twice -> 409', reComplete.status === 409, `got ${reComplete.status}`);
  const scanAfterComplete = await call('POST', `/transactions/${txId}/items`, { sku: skuA });
  check('scanning a completed transaction -> 409', scanAfterComplete.status === 409,
    `got ${scanAfterComplete.status}`);
  const missingComplete = await call('POST', '/transactions/tx-does-not-exist/complete');
  check('completing an unknown transaction -> 404', missingComplete.status === 404,
    `got ${missingComplete.status}`);

  const emptyTx = await call('POST', '/transactions', { stationId: 'station-smoke' });
  const emptyComplete = await call('POST', `/transactions/${emptyTx.json.transactionId}/complete`);
  check('completing an empty basket -> 409', emptyComplete.status === 409, `got ${emptyComplete.status}`);

  const afterComplete = await call('GET', `/transactions/${txId}`);
  check('status is COMPLETED after completion', afterComplete.json?.status === 'COMPLETED',
    `got ${afterComplete.json?.status}`);

  // --- GET /inventory/low-stock -----------------------------------------
  const low = await call('GET', '/inventory/low-stock');
  check('GET /inventory/low-stock -> 200', low.status === 200, `got ${low.status}`);
  check('LowStockResponse has {threshold,generatedAt,alerts}',
    hasKeys(low.json, ['threshold', 'generatedAt', 'alerts']), JSON.stringify(low.json)?.slice(0, 200));
  check('alerts is an array', Array.isArray(low.json?.alerts));

  // Force at least one alert by overriding the threshold above current stock.
  const lowForced = await call('GET', '/inventory/low-stock?threshold=999999');
  check('threshold override -> 200', lowForced.status === 200, `got ${lowForced.status}`);
  check('threshold override is echoed back', lowForced.json?.threshold === 999999,
    `got ${lowForced.json?.threshold}`);
  check('threshold override produces alerts', lowForced.json?.alerts?.length > 0);
  check('LowStockAlert has all required fields',
    hasKeys(lowForced.json?.alerts?.[0], ['sku', 'name', 'currentStock', 'threshold', 'triggeredAt']),
    JSON.stringify(lowForced.json?.alerts?.[0]));

  const stockOfA = lowForced.json.alerts.find((a) => a.sku === skuA);
  check('stock was decremented by 2 at completion',
    stockOfA && stockOfA.currentStock === catalogInitialStock() - 2,
    `got ${stockOfA?.currentStock}`);

  // --- GET /analytics/popular-items -------------------------------------
  const popular = await call('GET', '/analytics/popular-items?limit=5');
  check('GET /analytics/popular-items -> 200', popular.status === 200, `got ${popular.status}`);
  check('PopularItemsResponse has all required fields',
    hasKeys(popular.json, ['windowSize', 'slideInterval', 'windowStart', 'windowEnd', 'computedAt', 'items']),
    JSON.stringify(popular.json)?.slice(0, 200));
  check('popular items respects limit', (popular.json?.items?.length ?? 0) <= 5);
  if (popular.json?.items?.length > 0) {
    check('PopularItem has {sku,name,scanCount,rank}',
      hasKeys(popular.json.items[0], ['sku', 'name', 'scanCount', 'rank']),
      JSON.stringify(popular.json.items[0]));
    check('first rank is 1', popular.json.items[0].rank === 1, `got ${popular.json.items[0].rank}`);
  }

  // --- report -----------------------------------------------------------
  console.log(`\n${passed} checks passed, ${failures.length} failed.`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log('All contract checks passed.');
}

// STOCK_PER_ITEM as the server was started with; the smoke test only ever
// touches a fresh DB, so initial stock is the configured value.
function catalogInitialStock() {
  return Number.parseInt(process.env.STOCK_PER_ITEM || '10000', 10);
}

main().catch((err) => {
  console.error('Smoke test failed to run:', err);
  process.exit(2);
});
