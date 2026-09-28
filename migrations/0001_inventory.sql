PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS categories (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, offer_id TEXT NOT NULL UNIQUE,
 item_kind TEXT NOT NULL DEFAULT 'account' CHECK(item_kind IN ('account','code')),
 slip TEXT NOT NULL, activate_till TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
 id TEXT PRIMARY KEY, created_at TEXT, status TEXT NOT NULL, fake INTEGER NOT NULL DEFAULT 0,
 amount_kopecks INTEGER, payout_kopecks INTEGER, currency TEXT,
 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inventory (
 id TEXT PRIMARY KEY, category_id TEXT NOT NULL REFERENCES categories(id),
 kind TEXT NOT NULL CHECK(kind IN ('account','code')),
 secret TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','reserved','sold','blocked')),
 order_id TEXT REFERENCES orders(id), item_id TEXT,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS inventory_pool ON inventory(category_id,status,created_at);
CREATE TABLE IF NOT EXISTS deliveries (
 order_id TEXT PRIMARY KEY REFERENCES orders(id),
 state TEXT NOT NULL CHECK(state IN ('prepared','sending','accepted','uncertain','rejected')),
 payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS delivery_units (
 order_id TEXT NOT NULL REFERENCES orders(id), item_id TEXT NOT NULL, unit_index INTEGER NOT NULL,
 inventory_id TEXT REFERENCES inventory(id), secret TEXT NOT NULL,
 PRIMARY KEY(order_id,item_id,unit_index)
);
CREATE TABLE IF NOT EXISTS audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
 name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
);
