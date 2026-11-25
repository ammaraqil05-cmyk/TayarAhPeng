import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import { resetDbCache } from '../src/db.js';

/**
 * Lightweight Cloudflare D1 adapter backed by real SQLite (`node:sqlite`).
 * Supports `prepare().bind().first()/all()/run()`, `batch()`, and tracks DDL calls.
 */
function createD1Adapter({ blobAsNumberArray = true } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');

  const stats = { createTableCalls: 0, batchCalls: 0 };

  function normalizeParam(v) {
    if (v === undefined) return null;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return v;
  }

  function normalizeRow(row) {
    if (!row) return null;
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      if (v instanceof Uint8Array && blobAsNumberArray) {
        // Production Cloudflare D1 returns BLOB columns as number[]
        out[k] = Array.from(v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  function makeStatement(sql, bound = []) {
    return {
      sql,
      bound,
      bind(...params) {
        return makeStatement(sql, params.map(normalizeParam));
      },
      async first() {
        const stmt = sqlite.prepare(sql);
        const row = stmt.get(...bound);
        return normalizeRow(row);
      },
      async all() {
        const stmt = sqlite.prepare(sql);
        const rows = stmt.all(...bound).map(normalizeRow);
        return { results: rows, success: true };
      },
      async run() {
        if (/CREATE\s+TABLE/i.test(sql)) {
          stats.createTableCalls += 1;
        }
        const stmt = sqlite.prepare(sql);
        const info = stmt.run(...bound);
        return {
          success: true,
          meta: {
            last_row_id: Number(info.lastInsertRowid || 0),
            changes: Number(info.changes || 0),
          },
        };
      },
    };
  }

  return {
    stats,
    prepare(sql) {
      return makeStatement(sql);
    },
    async batch(statements) {
      stats.batchCalls += 1;
      const results = [];
      sqlite.exec('BEGIN');
      try {
        for (const st of statements) {
          if (/^\s*SELECT\b/i.test(st.sql)) {
            results.push(await st.all());
          } else {
            results.push(await st.run());
          }
        }
        sqlite.exec('COMMIT');
      } catch (err) {
        sqlite.exec('ROLLBACK');
        throw err;
      }
      return results;
    },
  };
}

async function req(db, envOverrides, path, options = {}) {
  const url = `https://tayarahpeng.example${path}`;
  const request = new Request(url, options);
  const env = { DB: db, ...envOverrides };
  return worker.fetch(request, env);
}

test('ensureDb auto-creates tables, seeds 15 items, and caches via dbReady', async () => {
  resetDbCache();
  const db = createD1Adapter();

  const res1 = await req(db, {}, '/api/kiosk');
  assert.equal(res1.status, 200);
  const body1 = await res1.json();
  assert.equal(body1.settings.shop_name, 'Kedai Tayar Ah Peng');
  assert.equal(body1.categories.length, 4);
  assert.equal(body1.items.length, 15);
  const initialCreateCalls = db.stats.createTableCalls;
  assert.equal(initialCreateCalls, 6);

  // Subsequent requests must NOT repeat CREATE TABLE
  const res2 = await req(db, {}, '/api/kiosk');
  assert.equal(res2.status, 200);
  assert.equal(db.stats.createTableCalls, initialCreateCalls);
});

test('POST /api/orders calculates price server-side, uses db.batch(), and generates sequential queue_number from orderId', async () => {
  resetDbCache();
  const db = createD1Adapter();

  const kioskRes = await req(db, {}, '/api/kiosk');
  const kiosk = await kioskRes.json();
  const item1 = kiosk.items[0]; // RM 9.50 (950)
  const item2 = kiosk.items[1]; // RM 8.50 (850)

  const batchBefore = db.stats.batchCalls;
  const orderRes1 = await req(db, {}, '/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      order_type: 'dine_in',
      customer_note: 'Kurang pedas',
      // Attempted client-side spoofed price must be ignored
      total_cents: 1,
      items: [
        { menu_item_id: item1.id, quantity: 2, price_cents: 1 },
        { menu_item_id: item2.id, quantity: 1 },
      ],
    }),
  });

  assert.equal(orderRes1.status, 201);
  const order1 = await orderRes1.json();
  assert.equal(order1.id, 1);
  assert.equal(order1.queue_number, 'AP-001');
  assert.equal(order1.total_cents, item1.price_cents * 2 + item2.price_cents);
  assert.equal(order1.items.length, 2);
  assert.ok(db.stats.batchCalls > batchBefore);

  // Second order must increment sequentially
  const orderRes2 = await req(db, {}, '/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      order_type: 'takeaway',
      items: [{ menu_item_id: item2.id, quantity: 3 }],
    }),
  });
  assert.equal(orderRes2.status, 201);
  const order2 = await orderRes2.json();
  assert.equal(order2.id, 2);
  assert.equal(order2.queue_number, 'AP-002');
  assert.equal(order2.total_cents, item2.price_cents * 3);

  // Live order status endpoint
  const statusRes = await req(db, {}, `/api/orders/${order1.id}`);
  assert.equal(statusRes.status, 200);
  const statusData = await statusRes.json();
  assert.equal(statusData.status, 'pending');
  assert.equal(statusData.queue_number, 'AP-001');
});

test('Admin auth returns 503 when ADMIN_PASSWORD is not set', async () => {
  resetDbCache();
  const db = createD1Adapter();

  const sRes = await req(db, {}, '/api/admin/session');
  assert.equal(sRes.status, 503);

  const lRes = await req(db, {}, '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'any' }),
  });
  assert.equal(lRes.status, 503);
});

test('Admin CMS operations, category 409 guard, store closed check, and D1 image ArrayBuffer round-trip', async () => {
  resetDbCache();
  const db = createD1Adapter({ blobAsNumberArray: true });
  const env = { ADMIN_PASSWORD: 'rahsia-ah-peng' };

  // Wrong password -> 401
  const badLogin = await req(db, env, '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'salah' }),
  });
  assert.equal(badLogin.status, 401);

  // Valid login -> 200 + token
  const goodLogin = await req(db, env, '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'rahsia-ah-peng' }),
  });
  assert.equal(goodLogin.status, 200);
  const { token } = await goodLogin.json();
  assert.ok(token);
  const authHeaders = { Authorization: `Bearer ${token}` };

  // Close store & verify POST /api/orders is blocked (403)
  const closeRes = await req(db, env, '/api/admin/settings', {
    method: 'PUT',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      shop_name: 'Kedai Tayar Ah Peng (Cawangan Utama)',
      banner_text: 'Rehat sebentar',
      is_open: 0,
    }),
  });
  assert.equal(closeRes.status, 200);

  const blockedOrder = await req(db, env, '/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      order_type: 'dine_in',
      items: [{ menu_item_id: 1, quantity: 1 }],
    }),
  });
  assert.equal(blockedOrder.status, 403);

  // Reopen store
  await req(db, env, '/api/admin/settings', {
    method: 'PUT',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_open: 1 }),
  });

  // Category with items -> DELETE must return 409 Conflict
  const delNonEmptyCat = await req(db, env, '/api/admin/categories/1', {
    method: 'DELETE',
    headers: authHeaders,
  });
  assert.equal(delNonEmptyCat.status, 409);

  // Empty category -> DELETE succeeds (200)
  const newCatRes = await req(db, env, '/api/admin/categories', {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Kategori Ujian', emoji: '🧪', sort_order: 99 }),
  });
  assert.equal(newCatRes.status, 201);
  const newCat = await newCatRes.json();

  const delEmptyCat = await req(db, env, `/api/admin/categories/${newCat.id}`, {
    method: 'DELETE',
    headers: authHeaders,
  });
  assert.equal(delEmptyCat.status, 200);

  // Image upload (< 95 KB) & retrieval via Uint8Array.from(row.data || [])
  const sampleJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
  const form = new FormData();
  form.append('file', new Blob([sampleJpeg], { type: 'image/jpeg' }), 'test.jpg');

  const upRes = await req(db, env, '/api/admin/images', {
    method: 'POST',
    headers: authHeaders,
    body: form,
  });
  assert.equal(upRes.status, 201);
  const uploaded = await upRes.json();
  assert.equal(uploaded.size_bytes, sampleJpeg.byteLength);

  const imgRes = await req(db, env, `/api/images/${uploaded.id}`);
  assert.equal(imgRes.status, 200);
  assert.equal(imgRes.headers.get('Content-Type'), 'image/jpeg');
  const gotBytes = new Uint8Array(await imgRes.arrayBuffer());
  assert.deepEqual(gotBytes, sampleJpeg);

  // Oversized image (>= 95 KB) rejected with 413
  const bigBytes = new Uint8Array(95 * 1024);
  const bigForm = new FormData();
  bigForm.append('file', new Blob([bigBytes], { type: 'image/jpeg' }), 'big.jpg');
  const bigRes = await req(db, env, '/api/admin/images', {
    method: 'POST',
    headers: authHeaders,
    body: bigForm,
  });
  assert.equal(bigRes.status, 413);

  // Quick price update & duplicate item
  const patchPrice = await req(db, env, '/api/admin/items/1', {
    method: 'PATCH',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ price: 11.2 }),
  });
  assert.equal(patchPrice.status, 200);
  const patchedItem = await patchPrice.json();
  assert.equal(patchedItem.price_cents, 1120);

  const dupRes = await req(db, env, '/api/admin/items/1/duplicate', {
    method: 'POST',
    headers: authHeaders,
  });
  assert.equal(dupRes.status, 201);
  const dupItem = await dupRes.json();
  assert.match(dupItem.name, /\(Salinan\)$/);

  // Create order & update status from Admin CMS
  const orderRes = await req(db, env, '/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      order_type: 'dine_in',
      items: [{ menu_item_id: 1, quantity: 1 }],
    }),
  });
  assert.equal(orderRes.status, 201);
  const createdOrder = await orderRes.json();

  const statusUpdate = await req(db, env, `/api/admin/orders/${createdOrder.id}/status`, {
    method: 'PATCH',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'ready' }),
  });
  assert.equal(statusUpdate.status, 200);
  const updatedOrder = await statusUpdate.json();
  assert.equal(updatedOrder.status, 'ready');
});
