import { ensureDb, formatQueueNumber } from './db.js';
import {
  buildSessionCookie,
  createSessionToken,
  requireAdmin,
  verifyPassword,
} from './auth.js';

const MAX_IMAGE_BYTES = 95 * 1024;
const ALLOWED_ORDER_STATUSES = new Set([
  'pending',
  'preparing',
  'ready',
  'completed',
  'cancelled',
]);

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function parsePositiveId(raw) {
  const num = Number(raw);
  if (!Number.isInteger(num) || num <= 0) return null;
  return num;
}

function parsePriceCents(body) {
  if (body && body.price_cents !== undefined && body.price_cents !== null) {
    const cents = Number(body.price_cents);
    if (Number.isInteger(cents) && cents >= 0 && cents <= 10_000_000) {
      return cents;
    }
    return null;
  }
  if (body && body.price !== undefined && body.price !== null) {
    const rm = Number(body.price);
    if (Number.isFinite(rm) && rm >= 0 && rm <= 100_000) {
      return Math.round(rm * 100);
    }
    return null;
  }
  return null;
}

async function getLastInsertId(db, runResult) {
  if (runResult?.meta?.last_row_id) {
    return Number(runResult.meta.last_row_id);
  }
  const row = await db.prepare('SELECT last_insert_rowid() AS id').first();
  return Number(row?.id);
}

async function attachOrderItems(db, orders) {
  if (!orders.length) return [];
  const ids = orders.map((o) => o.id);
  const placeholders = ids.map(() => '?').join(',');
  const { results: items } = await db
    .prepare(
      `SELECT id, order_id, menu_item_id, item_name, unit_price_cents, quantity, subtotal_cents
       FROM order_items
       WHERE order_id IN (${placeholders})
       ORDER BY id ASC`
    )
    .bind(...ids)
    .all();

  const grouped = new Map();
  for (const item of items || []) {
    const list = grouped.get(item.order_id) || [];
    list.push(item);
    grouped.set(item.order_id, list);
  }

  return orders.map((order) => ({
    ...order,
    items: grouped.get(order.id) || [],
  }));
}

async function handlePublicKiosk(db) {
  const [settings, categoriesRes, itemsRes] = await db.batch([
    db.prepare('SELECT id, shop_name, banner_text, is_open, updated_at FROM settings WHERE id = 1'),
    db.prepare(
      `SELECT id, name, emoji, sort_order, is_active
       FROM categories
       WHERE is_active = 1
       ORDER BY sort_order ASC, id ASC`
    ),
    db.prepare(
      `SELECT m.id, m.category_id, m.name, m.description, m.price_cents, m.emoji, m.image_id, m.is_active, m.sort_order
       FROM menu_items m
       JOIN categories c ON c.id = m.category_id
       WHERE m.is_active = 1 AND c.is_active = 1
       ORDER BY c.sort_order ASC, m.sort_order ASC, m.id ASC`
    ),
  ]);

  return jsonResponse({
    settings: settings.results?.[0] || {
      id: 1,
      shop_name: 'Kedai Tayar Ah Peng',
      banner_text: '',
      is_open: 1,
    },
    categories: categoriesRes.results || [],
    items: itemsRes.results || [],
  });
}

async function handleCreateOrder(request, db) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object') {
    return jsonResponse({ error: 'Format permintaan JSON tidak sah.' }, 400);
  }

  // Always check store open status on the server
  const settings = await db
    .prepare('SELECT is_open FROM settings WHERE id = 1')
    .first();
  if (!settings || Number(settings.is_open) !== 1) {
    return jsonResponse(
      { error: 'Maaf, kedai sedang ditutup buat sementara waktu.' },
      403
    );
  }

  const orderType = body.order_type;
  if (orderType !== 'dine_in' && orderType !== 'takeaway') {
    return jsonResponse(
      { error: 'Sila pilih jenis pesanan: Makan Sini atau Bungkus.' },
      400
    );
  }

  const customerNote =
    typeof body.customer_note === 'string'
      ? body.customer_note.trim().slice(0, 200)
      : '';

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return jsonResponse({ error: 'Troli anda masih kosong.' }, 400);
  }

  // Merge duplicate item IDs and validate quantities
  const requestedQtyMap = new Map();
  for (const entry of body.items) {
    const itemId = parsePositiveId(entry?.menu_item_id);
    const qty = Number(entry?.quantity);
    if (!itemId || !Number.isInteger(qty) || qty < 1 || qty > 99) {
      return jsonResponse(
        { error: 'Item atau kuantiti pesanan tidak sah (1 hingga 99).' },
        400
      );
    }
    const nextQty = (requestedQtyMap.get(itemId) || 0) + qty;
    if (nextQty > 99) {
      return jsonResponse(
        { error: 'Kuantiti maksimum bagi satu item ialah 99.' },
        400
      );
    }
    requestedQtyMap.set(itemId, nextQty);
  }

  const itemIds = Array.from(requestedQtyMap.keys());
  const placeholders = itemIds.map(() => '?').join(',');
  const { results: dbItems } = await db
    .prepare(
      `SELECT m.id, m.name, m.price_cents, m.is_active, c.is_active AS category_active
       FROM menu_items m
       JOIN categories c ON c.id = m.category_id
       WHERE m.id IN (${placeholders})`
    )
    .bind(...itemIds)
    .all();

  const dbItemMap = new Map((dbItems || []).map((row) => [Number(row.id), row]));

  // Compute all item subtotals and total_cents strictly on the server
  let totalCents = 0;
  const normalizedLines = [];
  for (const [itemId, qty] of requestedQtyMap.entries()) {
    const item = dbItemMap.get(itemId);
    if (!item || Number(item.is_active) !== 1 || Number(item.category_active) !== 1) {
      return jsonResponse(
        { error: 'Sebahagian menu yang dipilih tidak lagi aktif atau tidak wujud.' },
        400
      );
    }
    const unitPriceCents = Number(item.price_cents);
    const subtotalCents = unitPriceCents * qty;
    totalCents += subtotalCents;
    normalizedLines.push({
      menu_item_id: itemId,
      item_name: item.name,
      unit_price_cents: unitPriceCents,
      quantity: qty,
      subtotal_cents: subtotalCents,
    });
  }

  // Insert order first to obtain sequential orderId
  const insertOrderRes = await db
    .prepare(
      `INSERT INTO orders (queue_number, order_type, customer_note, total_cents, status)
       VALUES ('', ?, ?, ?, 'pending')`
    )
    .bind(orderType, customerNote, totalCents)
    .run();

  const orderId = await getLastInsertId(db, insertOrderRes);
  if (!orderId) {
    return jsonResponse({ error: 'Gagal menjana ID pesanan.' }, 500);
  }

  // Queue number derived deterministically from orderId (never random)
  const queueNumber = formatQueueNumber(orderId);

  const batchStmts = [
    db
      .prepare(
        `UPDATE orders SET queue_number = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      )
      .bind(queueNumber, orderId),
    ...normalizedLines.map((line) =>
      db
        .prepare(
          `INSERT INTO order_items (order_id, menu_item_id, item_name, unit_price_cents, quantity, subtotal_cents)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(
          orderId,
          line.menu_item_id,
          line.item_name,
          line.unit_price_cents,
          line.quantity,
          line.subtotal_cents
        )
    ),
  ];

  await db.batch(batchStmts);

  const createdOrder = await db
    .prepare(
      `SELECT id, queue_number, order_type, customer_note, total_cents, status, created_at, updated_at
       FROM orders WHERE id = ?`
    )
    .bind(orderId)
    .first();

  return jsonResponse(
    {
      ...createdOrder,
      items: normalizedLines,
    },
    201
  );
}

async function handleGetOrderStatus(id, db) {
  const orderId = parsePositiveId(id);
  if (!orderId) {
    return jsonResponse({ error: 'ID pesanan tidak sah.' }, 400);
  }

  const order = await db
    .prepare(
      `SELECT id, queue_number, order_type, customer_note, total_cents, status, created_at, updated_at
       FROM orders WHERE id = ?`
    )
    .bind(orderId)
    .first();

  if (!order) {
    return jsonResponse({ error: 'Pesanan tidak dijumpai.' }, 404);
  }

  const [withItems] = await attachOrderItems(db, [order]);
  return jsonResponse(withItems);
}

async function handleGetImage(id, db) {
  const imageId = parsePositiveId(id);
  if (!imageId) {
    return new Response('Invalid image ID', { status: 400 });
  }

  const row = await db
    .prepare('SELECT mime_type, data FROM images WHERE id = ?')
    .bind(imageId)
    .first();

  if (!row || !row.data) {
    return new Response('Not found', { status: 404 });
  }

  // Convert D1 BLOB byte array reliably using Uint8Array.from(row.data || [])
  const bytes =
    row.data instanceof ArrayBuffer
      ? new Uint8Array(row.data)
      : Uint8Array.from(row.data || []);

  if (bytes.byteLength === 0) {
    return new Response('Empty image', { status: 404 });
  }

  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': row.mime_type || 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}

async function handleAdminUploadImage(request, db) {
  const contentType = request.headers.get('Content-Type') || '';
  let mimeType = 'image/jpeg';
  let bytes = null;

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData();
    const file = form.get('file');
    if (!file || typeof file === 'string') {
      return jsonResponse({ error: 'Fail gambar diperlukan.' }, 400);
    }
    mimeType = file.type || 'image/jpeg';
    bytes = new Uint8Array(await file.arrayBuffer());
  } else if (contentType.includes('application/json')) {
    const body = await readJson(request);
    if (!body || typeof body.data_base64 !== 'string') {
      return jsonResponse({ error: 'Data gambar base64 tidak sah.' }, 400);
    }
    mimeType = typeof body.mime_type === 'string' && body.mime_type ? body.mime_type : 'image/jpeg';
    const rawB64 = body.data_base64.replace(/^data:[^;]+;base64,/, '');
    try {
      const bin = atob(rawB64);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
      }
    } catch {
      return jsonResponse({ error: 'Penyahkodan base64 gagal.' }, 400);
    }
  } else if (contentType.startsWith('image/')) {
    mimeType = contentType.split(';')[0].trim();
    bytes = new Uint8Array(await request.arrayBuffer());
  } else {
    return jsonResponse({ error: 'Content-Type gambar tidak disokong.' }, 415);
  }

  if (!bytes || bytes.byteLength === 0) {
    return jsonResponse({ error: 'Fail gambar kosong.' }, 400);
  }

  if (bytes.byteLength >= MAX_IMAGE_BYTES) {
    return jsonResponse(
      { error: 'Saiz gambar mesti dimampatkan bawah 95 KB sebelum dimuat naik.' },
      413
    );
  }

  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
    mimeType = 'image/jpeg';
  }

  const res = await db
    .prepare('INSERT INTO images (mime_type, data, size_bytes) VALUES (?, ?, ?)')
    .bind(mimeType, bytes.buffer, bytes.byteLength)
    .run();

  const imageId = await getLastInsertId(db, res);
  return jsonResponse(
    {
      id: imageId,
      url: `/api/images/${imageId}`,
      mime_type: mimeType,
      size_bytes: bytes.byteLength,
    },
    201
  );
}

async function handleAdminDashboard(db) {
  const [settingsRes, categoriesRes, itemsRes, ordersRes] = await db.batch([
    db.prepare('SELECT id, shop_name, banner_text, is_open, updated_at FROM settings WHERE id = 1'),
    db.prepare(
      `SELECT c.id, c.name, c.emoji, c.sort_order, c.is_active,
              COUNT(m.id) AS item_count
       FROM categories c
       LEFT JOIN menu_items m ON m.category_id = c.id
       GROUP BY c.id
       ORDER BY c.sort_order ASC, c.id ASC`
    ),
    db.prepare(
      `SELECT m.id, m.category_id, m.name, m.description, m.price_cents, m.emoji, m.image_id, m.is_active, m.sort_order, m.created_at,
              c.name AS category_name
       FROM menu_items m
       LEFT JOIN categories c ON c.id = m.category_id
       ORDER BY c.sort_order ASC, m.sort_order ASC, m.id ASC`
    ),
    db.prepare(
      `SELECT id, queue_number, order_type, customer_note, total_cents, status, created_at, updated_at
       FROM orders
       ORDER BY id DESC
       LIMIT 100`
    ),
  ]);

  const ordersWithItems = await attachOrderItems(db, ordersRes.results || []);

  return jsonResponse({
    settings: settingsRes.results?.[0] || null,
    categories: categoriesRes.results || [],
    items: itemsRes.results || [],
    orders: ordersWithItems,
  });
}

async function handleAdminRoutes(request, env, db, url) {
  const path = url.pathname;
  const method = request.method;

  // Login endpoint: checks ADMIN_PASSWORD -> 503 if unset
  if (path === '/api/admin/login' && method === 'POST') {
    const adminPassword = env?.ADMIN_PASSWORD;
    if (!adminPassword || String(adminPassword).trim() === '') {
      return jsonResponse(
        {
          error:
            'ADMIN_PASSWORD belum dikonfigurasi. Sila tetapkan secret ADMIN_PASSWORD dalam Cloudflare Worker atau .dev.vars.',
        },
        503
      );
    }

    const body = await readJson(request);
    const submitted = body?.password;
    const valid = await verifyPassword(submitted, String(adminPassword));
    if (!valid) {
      return jsonResponse({ error: 'Kata laluan tidak sah.' }, 401);
    }

    const token = await createSessionToken(String(adminPassword));
    return jsonResponse(
      { ok: true, token },
      200,
      { 'Set-Cookie': buildSessionCookie(token, request, false) }
    );
  }

  if (path === '/api/admin/logout' && method === 'POST') {
    return jsonResponse(
      { ok: true },
      200,
      { 'Set-Cookie': buildSessionCookie('', request, true) }
    );
  }

  // All remaining /api/admin/* endpoints require valid session & configured ADMIN_PASSWORD
  const authError = await requireAdmin(request, env, jsonResponse);
  if (authError) return authError;

  if (path === '/api/admin/session' && method === 'GET') {
    return jsonResponse({ authenticated: true });
  }

  if (path === '/api/admin/dashboard' && method === 'GET') {
    return handleAdminDashboard(db);
  }

  // Store settings
  if (path === '/api/admin/settings' && method === 'PUT') {
    const body = await readJson(request);
    if (!body) return jsonResponse({ error: 'JSON tidak sah.' }, 400);

    const existing = await db.prepare('SELECT shop_name, banner_text, is_open FROM settings WHERE id = 1').first();
    const shopName =
      typeof body.shop_name === 'string' && body.shop_name.trim()
        ? body.shop_name.trim().slice(0, 80)
        : existing?.shop_name || 'Kedai Tayar Ah Peng';
    const bannerText =
      typeof body.banner_text === 'string'
        ? body.banner_text.trim().slice(0, 240)
        : existing?.banner_text || '';
    const isOpen =
      body.is_open !== undefined ? (body.is_open ? 1 : 0) : Number(existing?.is_open ?? 1);

    await db
      .prepare(
        `UPDATE settings
         SET shop_name = ?, banner_text = ?, is_open = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = 1`
      )
      .bind(shopName, bannerText, isOpen)
      .run();

    const updated = await db
      .prepare('SELECT id, shop_name, banner_text, is_open, updated_at FROM settings WHERE id = 1')
      .first();
    return jsonResponse(updated);
  }

  // Categories
  if (path === '/api/admin/categories' && method === 'GET') {
    const { results } = await db
      .prepare(
        `SELECT c.id, c.name, c.emoji, c.sort_order, c.is_active, COUNT(m.id) AS item_count
         FROM categories c
         LEFT JOIN menu_items m ON m.category_id = c.id
         GROUP BY c.id
         ORDER BY c.sort_order ASC, c.id ASC`
      )
      .all();
    return jsonResponse({ categories: results || [] });
  }

  if (path === '/api/admin/categories' && method === 'POST') {
    const body = await readJson(request);
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name) return jsonResponse({ error: 'Nama kategori diperlukan.' }, 400);
    const emoji = typeof body?.emoji === 'string' && body.emoji.trim() ? body.emoji.trim().slice(0, 8) : '🍽️';
    const sortOrder = Number.isInteger(Number(body?.sort_order)) ? Number(body.sort_order) : 0;
    const isActive = body?.is_active === false || body?.is_active === 0 ? 0 : 1;

    const res = await db
      .prepare('INSERT INTO categories (name, emoji, sort_order, is_active) VALUES (?, ?, ?, ?)')
      .bind(name.slice(0, 60), emoji, sortOrder, isActive)
      .run();
    const id = await getLastInsertId(db, res);
    const created = await db.prepare('SELECT *, 0 AS item_count FROM categories WHERE id = ?').bind(id).first();
    return jsonResponse(created, 201);
  }

  const catMatch = path.match(/^\/api\/admin\/categories\/(\d+)(?:\/(toggle))?$/);
  if (catMatch) {
    const catId = parsePositiveId(catMatch[1]);
    if (!catId) return jsonResponse({ error: 'ID kategori tidak sah.' }, 400);
    const action = catMatch[2];

    if (action === 'toggle' && method === 'PATCH') {
      const existing = await db.prepare('SELECT * FROM categories WHERE id = ?').bind(catId).first();
      if (!existing) return jsonResponse({ error: 'Kategori tidak dijumpai.' }, 404);
      const body = await readJson(request);
      const nextActive =
        body && body.is_active !== undefined
          ? body.is_active ? 1 : 0
          : Number(existing.is_active) === 1 ? 0 : 1;
      await db.prepare('UPDATE categories SET is_active = ? WHERE id = ?').bind(nextActive, catId).run();
      const updated = await db.prepare('SELECT * FROM categories WHERE id = ?').bind(catId).first();
      return jsonResponse(updated);
    }

    if (!action && method === 'PUT') {
      const existing = await db.prepare('SELECT * FROM categories WHERE id = ?').bind(catId).first();
      if (!existing) return jsonResponse({ error: 'Kategori tidak dijumpai.' }, 404);
      const body = await readJson(request);
      const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 60) : existing.name;
      const emoji = typeof body?.emoji === 'string' && body.emoji.trim() ? body.emoji.trim().slice(0, 8) : existing.emoji;
      const sortOrder = body?.sort_order !== undefined ? Number(body.sort_order) || 0 : existing.sort_order;
      const isActive = body?.is_active !== undefined ? (body.is_active ? 1 : 0) : existing.is_active;

      await db
        .prepare('UPDATE categories SET name = ?, emoji = ?, sort_order = ?, is_active = ? WHERE id = ?')
        .bind(name, emoji, sortOrder, isActive, catId)
        .run();
      const updated = await db.prepare('SELECT * FROM categories WHERE id = ?').bind(catId).first();
      return jsonResponse(updated);
    }

    if (!action && method === 'DELETE') {
      const existing = await db.prepare('SELECT id FROM categories WHERE id = ?').bind(catId).first();
      if (!existing) return jsonResponse({ error: 'Kategori tidak dijumpai.' }, 404);

      // Block deleting category with 409 if it still has items
      const countRow = await db
        .prepare('SELECT COUNT(*) AS cnt FROM menu_items WHERE category_id = ?')
        .bind(catId)
        .first();
      if (Number(countRow?.cnt || 0) > 0) {
        return jsonResponse(
          {
            error: `Kategori tidak boleh dipadam kerana masih mempunyai ${countRow.cnt} item menu. Sila pindah atau padam item terlebih dahulu.`,
          },
          409
        );
      }

      await db.prepare('DELETE FROM categories WHERE id = ?').bind(catId).run();
      return jsonResponse({ ok: true, deleted_id: catId });
    }
  }

  // Image upload
  if (path === '/api/admin/images' && method === 'POST') {
    return handleAdminUploadImage(request, db);
  }

  // Menu items
  if (path === '/api/admin/items' && method === 'POST') {
    const body = await readJson(request);
    if (!body) return jsonResponse({ error: 'JSON tidak sah.' }, 400);

    const categoryId = parsePositiveId(body.category_id);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const priceCents = parsePriceCents(body);

    if (!categoryId || !name || priceCents === null) {
      return jsonResponse(
        { error: 'Kategori, nama item dan harga yang sah diperlukan.' },
        400
      );
    }

    const catExists = await db.prepare('SELECT id FROM categories WHERE id = ?').bind(categoryId).first();
    if (!catExists) return jsonResponse({ error: 'Kategori dipilih tidak wujud.' }, 404);

    const description = typeof body.description === 'string' ? body.description.trim().slice(0, 300) : '';
    const emoji = typeof body.emoji === 'string' && body.emoji.trim() ? body.emoji.trim().slice(0, 8) : '🍜';
    const imageId = body.image_id ? parsePositiveId(body.image_id) : null;
    const isActive = body.is_active === false || body.is_active === 0 ? 0 : 1;
    const sortOrder = Number.isInteger(Number(body.sort_order)) ? Number(body.sort_order) : 0;

    const res = await db
      .prepare(
        `INSERT INTO menu_items (category_id, name, description, price_cents, emoji, image_id, is_active, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(categoryId, name.slice(0, 100), description, priceCents, emoji, imageId, isActive, sortOrder)
      .run();

    const id = await getLastInsertId(db, res);
    const created = await db.prepare('SELECT * FROM menu_items WHERE id = ?').bind(id).first();
    return jsonResponse(created, 201);
  }

  const itemMatch = path.match(/^\/api\/admin\/items\/(\d+)(?:\/(duplicate))?$/);
  if (itemMatch) {
    const itemId = parsePositiveId(itemMatch[1]);
    if (!itemId) return jsonResponse({ error: 'ID item tidak sah.' }, 400);
    const action = itemMatch[2];

    if (action === 'duplicate' && method === 'POST') {
      const source = await db.prepare('SELECT * FROM menu_items WHERE id = ?').bind(itemId).first();
      if (!source) return jsonResponse({ error: 'Item menu tidak dijumpai.' }, 404);

      const copyName = `${source.name} (Salinan)`.slice(0, 100);
      const res = await db
        .prepare(
          `INSERT INTO menu_items (category_id, name, description, price_cents, emoji, image_id, is_active, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          source.category_id,
          copyName,
          source.description,
          source.price_cents,
          source.emoji,
          source.image_id,
          source.is_active,
          Number(source.sort_order || 0) + 1
        )
        .run();

      const newId = await getLastInsertId(db, res);
      const created = await db.prepare('SELECT * FROM menu_items WHERE id = ?').bind(newId).first();
      return jsonResponse(created, 201);
    }

    if (!action && method === 'PUT') {
      const existing = await db.prepare('SELECT * FROM menu_items WHERE id = ?').bind(itemId).first();
      if (!existing) return jsonResponse({ error: 'Item menu tidak dijumpai.' }, 404);
      const body = await readJson(request);
      if (!body) return jsonResponse({ error: 'JSON tidak sah.' }, 400);

      const categoryId = body.category_id !== undefined ? parsePositiveId(body.category_id) : existing.category_id;
      const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 100) : existing.name;
      const priceCents =
        body.price_cents !== undefined || body.price !== undefined
          ? parsePriceCents(body)
          : existing.price_cents;

      if (!categoryId || priceCents === null) {
        return jsonResponse({ error: 'Kategori atau harga tidak sah.' }, 400);
      }
      const catExists = await db.prepare('SELECT id FROM categories WHERE id = ?').bind(categoryId).first();
      if (!catExists) return jsonResponse({ error: 'Kategori dipilih tidak wujud.' }, 404);

      const description =
        body.description !== undefined
          ? String(body.description || '').trim().slice(0, 300)
          : existing.description;
      const emoji =
        typeof body.emoji === 'string' && body.emoji.trim()
          ? body.emoji.trim().slice(0, 8)
          : existing.emoji;
      const imageId =
        body.image_id === null
          ? null
          : body.image_id !== undefined
            ? parsePositiveId(body.image_id)
            : existing.image_id;
      const isActive =
        body.is_active !== undefined ? (body.is_active ? 1 : 0) : existing.is_active;
      const sortOrder =
        body.sort_order !== undefined ? Number(body.sort_order) || 0 : existing.sort_order;

      await db
        .prepare(
          `UPDATE menu_items
           SET category_id = ?, name = ?, description = ?, price_cents = ?, emoji = ?, image_id = ?, is_active = ?, sort_order = ?
           WHERE id = ?`
        )
        .bind(categoryId, name, description, priceCents, emoji, imageId, isActive, sortOrder, itemId)
        .run();

      const updated = await db.prepare('SELECT * FROM menu_items WHERE id = ?').bind(itemId).first();
      return jsonResponse(updated);
    }

    if (!action && method === 'PATCH') {
      const existing = await db.prepare('SELECT * FROM menu_items WHERE id = ?').bind(itemId).first();
      if (!existing) return jsonResponse({ error: 'Item menu tidak dijumpai.' }, 404);
      const body = await readJson(request);
      if (!body) return jsonResponse({ error: 'JSON tidak sah.' }, 400);

      let priceCents = existing.price_cents;
      if (body.price_cents !== undefined || body.price !== undefined) {
        priceCents = parsePriceCents(body);
        if (priceCents === null) {
          return jsonResponse({ error: 'Harga tidak sah.' }, 400);
        }
      }

      const isActive =
        body.is_active !== undefined ? (body.is_active ? 1 : 0) : existing.is_active;
      const imageId =
        body.image_id === null
          ? null
          : body.image_id !== undefined
            ? parsePositiveId(body.image_id)
            : existing.image_id;

      await db
        .prepare('UPDATE menu_items SET price_cents = ?, is_active = ?, image_id = ? WHERE id = ?')
        .bind(priceCents, isActive, imageId, itemId)
        .run();

      const updated = await db.prepare('SELECT * FROM menu_items WHERE id = ?').bind(itemId).first();
      return jsonResponse(updated);
    }

    if (!action && method === 'DELETE') {
      const existing = await db.prepare('SELECT id, image_id FROM menu_items WHERE id = ?').bind(itemId).first();
      if (!existing) return jsonResponse({ error: 'Item menu tidak dijumpai.' }, 404);

      await db.prepare('DELETE FROM menu_items WHERE id = ?').bind(itemId).run();

      // Clean up orphaned image if no other menu item references it
      if (existing.image_id) {
        const refRow = await db
          .prepare('SELECT COUNT(*) AS cnt FROM menu_items WHERE image_id = ?')
          .bind(existing.image_id)
          .first();
        if (Number(refRow?.cnt || 0) === 0) {
          await db.prepare('DELETE FROM images WHERE id = ?').bind(existing.image_id).run();
        }
      }
      return jsonResponse({ ok: true, deleted_id: itemId });
    }
  }

  // Orders management
  if (path === '/api/admin/orders' && method === 'GET') {
    const statusFilter = url.searchParams.get('status');
    let query = `SELECT id, queue_number, order_type, customer_note, total_cents, status, created_at, updated_at
                 FROM orders`;
    const params = [];
    if (statusFilter && ALLOWED_ORDER_STATUSES.has(statusFilter)) {
      query += ' WHERE status = ?';
      params.push(statusFilter);
    }
    query += ' ORDER BY id DESC LIMIT 100';

    const stmt = db.prepare(query);
    const { results } = params.length ? await stmt.bind(...params).all() : await stmt.all();
    const withItems = await attachOrderItems(db, results || []);
    return jsonResponse({ orders: withItems });
  }

  const orderStatusMatch = path.match(/^\/api\/admin\/orders\/(\d+)\/status$/);
  if (orderStatusMatch && method === 'PATCH') {
    const orderId = parsePositiveId(orderStatusMatch[1]);
    if (!orderId) return jsonResponse({ error: 'ID pesanan tidak sah.' }, 400);

    const body = await readJson(request);
    const nextStatus = body?.status;
    if (!ALLOWED_ORDER_STATUSES.has(nextStatus)) {
      return jsonResponse({ error: 'Status pesanan tidak sah.' }, 400);
    }

    const existing = await db.prepare('SELECT id FROM orders WHERE id = ?').bind(orderId).first();
    if (!existing) return jsonResponse({ error: 'Pesanan tidak dijumpai.' }, 404);

    await db
      .prepare('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(nextStatus, orderId)
      .run();

    const updated = await db
      .prepare(
        'SELECT id, queue_number, order_type, customer_note, total_cents, status, created_at, updated_at FROM orders WHERE id = ?'
      )
      .bind(orderId)
      .first();
    const [withItems] = await attachOrderItems(db, [updated]);
    return jsonResponse(withItems);
  }

  return jsonResponse({ error: 'Laluan API admin tidak dijumpai.' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith('/api/')) {
      try {
        if (path === '/api/health' && request.method === 'GET') {
          return jsonResponse({ ok: true });
        }

        if (!env.DB) {
          return jsonResponse({ error: 'Binding D1 DB tidak dijumpai.' }, 500);
        }

        await ensureDb(env.DB);

        if (path === '/api/kiosk' && request.method === 'GET') {
          return handlePublicKiosk(env.DB);
        }

        if (path === '/api/orders' && request.method === 'POST') {
          return handleCreateOrder(request, env.DB);
        }

        const orderMatch = path.match(/^\/api\/orders\/(\d+)$/);
        if (orderMatch && request.method === 'GET') {
          return handleGetOrderStatus(orderMatch[1], env.DB);
        }

        const imgMatch = path.match(/^\/api\/images\/(\d+)$/);
        if (imgMatch && request.method === 'GET') {
          return handleGetImage(imgMatch[1], env.DB);
        }

        if (path.startsWith('/api/admin/')) {
          return handleAdminRoutes(request, env, env.DB, url);
        }

        return jsonResponse({ error: 'Laluan API tidak dijumpai.' }, 404);
      } catch (err) {
        console.error('Worker API Error:', err);
        return jsonResponse(
          { error: 'Ralat pelayan dalaman.', detail: err?.message || String(err) },
          500
        );
      }
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
