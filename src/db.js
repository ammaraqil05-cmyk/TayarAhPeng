/**
 * D1 database initialization, seeding, and query helpers for Kedai Tayar Ah Peng.
 */

let dbReady = false;
let dbInitPromise = null;

const SEED_CATEGORIES = [
  { name: 'Makanan Panas', emoji: '🍜', sort_order: 1 },
  { name: 'Sarapan & Roti', emoji: '🍞', sort_order: 2 },
  { name: 'Snek & Sampingan', emoji: '🥟', sort_order: 3 },
  { name: 'Minuman Kopitiam', emoji: '☕', sort_order: 4 },
];

// 15 sample menu items across the 4 categories
const SEED_MENU_ITEMS = [
  {
    categoryIndex: 0,
    name: 'Nasi Lemak Ayam Goreng Berempah',
    description: 'Nasi lemak wangi santan dengan ayam goreng berempah rangup, sambal bilis, telur & kacang.',
    price_cents: 950,
    emoji: '🍗',
    sort_order: 1,
  },
  {
    categoryIndex: 0,
    name: 'Char Kuey Teow Udang Besar',
    description: 'Digoreng panas berapi wok hei dengan udang segar, taugeh dan kucai.',
    price_cents: 850,
    emoji: '🍜',
    sort_order: 2,
  },
  {
    categoryIndex: 0,
    name: 'Mee Goreng Mamak Special',
    description: 'Mee kuning tumis pedas manis bersama telur mata, tauhu dan cucur rangup.',
    price_cents: 750,
    emoji: '🍝',
    sort_order: 3,
  },
  {
    categoryIndex: 0,
    name: 'Nasi Goreng Kampung Ah Peng',
    description: 'Nasi goreng ikan bilis garing, kangkung dan cili padi gaya bengkel Ah Peng.',
    price_cents: 800,
    emoji: '🍚',
    sort_order: 4,
  },
  {
    categoryIndex: 0,
    name: 'Bihun Sup Daging Utara',
    description: 'Sup daging berempah jernih dengan bihun lembut, lobak asin dan sambal kicap.',
    price_cents: 850,
    emoji: '🍲',
    sort_order: 5,
  },
  {
    categoryIndex: 0,
    name: 'Wantan Mee Kicap Char Siu Ayam',
    description: 'Mee telur kenyal bersalut kicap pekat, ayam panggang madu dan wantan goreng.',
    price_cents: 800,
    emoji: '🥢',
    sort_order: 6,
  },
  {
    categoryIndex: 1,
    name: 'Roti Bakar Kaya & Mentega',
    description: 'Roti bakar arang rangup disapu kaya pandan asli dan mentega sejuk.',
    price_cents: 380,
    emoji: '🍞',
    sort_order: 1,
  },
  {
    categoryIndex: 1,
    name: 'Telur Separuh Masak (2 Biji)',
    description: 'Dua biji telur kampung separuh masak dihidang bersama kicap cair dan lada sulah.',
    price_cents: 320,
    emoji: '🥚',
    sort_order: 2,
  },
  {
    categoryIndex: 1,
    name: 'Roti Canai Telur Goyang',
    description: 'Roti canai garing berlapis dengan telur goyang dan kuah dal pekat.',
    price_cents: 400,
    emoji: '🫓',
    sort_order: 3,
  },
  {
    categoryIndex: 2,
    name: 'Karipap Kentang Rangup (3 Biji)',
    description: 'Inti kentang kari berempah dalam kulit pastri rangup keemasan.',
    price_cents: 350,
    emoji: '🥟',
    sort_order: 1,
  },
  {
    categoryIndex: 2,
    name: 'Kentang Goreng Tayar (Wedges)',
    description: 'Potongan kentang tebal goreng rangup bersama sos keju dan cili.',
    price_cents: 550,
    emoji: '🍟',
    sort_order: 2,
  },
  {
    categoryIndex: 3,
    name: 'Kopi O Kaw Panas',
    description: 'Kopi panggang tradisional pekat kaw dibancuh panas gaya kopitiam.',
    price_cents: 280,
    emoji: '☕',
    sort_order: 1,
  },
  {
    categoryIndex: 3,
    name: 'Teh Tarik Buih Melimpah',
    description: 'Teh susu pekat ditarik gebu berbuih halus, manis berlemak.',
    price_cents: 320,
    emoji: '🧋',
    sort_order: 2,
  },
  {
    categoryIndex: 3,
    name: 'Cham Ais Kaw',
    description: 'Gabungan kopi kaw dan teh susu berkrim dihidang sejuk berais.',
    price_cents: 380,
    emoji: '🧊',
    sort_order: 3,
  },
  {
    categoryIndex: 3,
    name: 'Limau Asam Boi Ais',
    description: 'Air limau kasturi segar bersama asam boi masin manis yang menyegarkan.',
    price_cents: 350,
    emoji: '🍋',
    sort_order: 4,
  },
];

/**
 * Resets the cached DB readiness flag (used primarily in unit tests).
 */
export function resetDbCache() {
  dbReady = false;
  dbInitPromise = null;
}

/**
 * Ensures all D1 tables exist and seeds initial settings, categories, and 15 sample items.
 * Cached via `dbReady` so CREATE TABLE is not repeated on every request.
 */
export async function ensureDb(db) {
  if (dbReady) return;
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = (async () => {
    try {
      await db.batch([
        db.prepare(`
          CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            shop_name TEXT NOT NULL DEFAULT 'Kedai Tayar Ah Peng',
            banner_text TEXT NOT NULL DEFAULT 'Servis Pantas, Perut Kenyang! Pesan makanan & kopi kaw terus dari skrin ini.',
            is_open INTEGER NOT NULL DEFAULT 1,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `),
        db.prepare(`
          CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            emoji TEXT NOT NULL DEFAULT '🍽️',
            sort_order INTEGER NOT NULL DEFAULT 0,
            is_active INTEGER NOT NULL DEFAULT 1
          )
        `),
        db.prepare(`
          CREATE TABLE IF NOT EXISTS images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
            data BLOB NOT NULL,
            size_bytes INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `),
        db.prepare(`
          CREATE TABLE IF NOT EXISTS menu_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            price_cents INTEGER NOT NULL,
            emoji TEXT NOT NULL DEFAULT '🍜',
            image_id INTEGER,
            is_active INTEGER NOT NULL DEFAULT 1,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (category_id) REFERENCES categories(id)
          )
        `),
        db.prepare(`
          CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            queue_number TEXT NOT NULL DEFAULT '',
            order_type TEXT NOT NULL CHECK (order_type IN ('dine_in', 'takeaway')),
            customer_note TEXT NOT NULL DEFAULT '',
            total_cents INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'preparing', 'ready', 'completed', 'cancelled')),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `),
        db.prepare(`
          CREATE TABLE IF NOT EXISTS order_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER NOT NULL,
            menu_item_id INTEGER NOT NULL,
            item_name TEXT NOT NULL,
            unit_price_cents INTEGER NOT NULL,
            quantity INTEGER NOT NULL,
            subtotal_cents INTEGER NOT NULL,
            FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
          )
        `),
      ]);

      // Seed default settings if missing
      await db
        .prepare(
          `INSERT OR IGNORE INTO settings (id, shop_name, banner_text, is_open)
           VALUES (1, ?, ?, 1)`
        )
        .bind(
          'Kedai Tayar Ah Peng',
          'Servis Pantas, Perut Kenyang! Pesan makanan & kopi kaw terus dari kiosk layan diri ini.'
        )
        .run();

      // Seed categories and 15 sample menu items only when categories table is empty
      const catCountRow = await db.prepare('SELECT COUNT(*) AS cnt FROM categories').first();
      if (!catCountRow || Number(catCountRow.cnt) === 0) {
        const categoryIds = [];
        for (const cat of SEED_CATEGORIES) {
          const res = await db
            .prepare('INSERT INTO categories (name, emoji, sort_order, is_active) VALUES (?, ?, ?, 1)')
            .bind(cat.name, cat.emoji, cat.sort_order)
            .run();
          let insertedId = res?.meta?.last_row_id;
          if (!insertedId) {
            const row = await db.prepare('SELECT last_insert_rowid() AS id').first();
            insertedId = row?.id;
          }
          categoryIds.push(insertedId);
        }

        const menuCountRow = await db.prepare('SELECT COUNT(*) AS cnt FROM menu_items').first();
        if (!menuCountRow || Number(menuCountRow.cnt) === 0) {
          const insertStmts = SEED_MENU_ITEMS.map((item) =>
            db
              .prepare(
                `INSERT INTO menu_items (category_id, name, description, price_cents, emoji, image_id, is_active, sort_order)
                 VALUES (?, ?, ?, ?, ?, NULL, 1, ?)`
              )
              .bind(
                categoryIds[item.categoryIndex],
                item.name,
                item.description,
                item.price_cents,
                item.emoji,
                item.sort_order
              )
          );
          await db.batch(insertStmts);
        }
      }

      dbReady = true;
    } catch (err) {
      dbInitPromise = null;
      dbReady = false;
      throw err;
    }
  })();

  return dbInitPromise;
}

/**
 * Formats an integer order ID into a sequential queue number (never random).
 */
export function formatQueueNumber(orderId) {
  return `AP-${String(orderId).padStart(3, '0')}`;
}
