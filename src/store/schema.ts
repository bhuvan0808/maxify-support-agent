/**
 * Database schema, as one statement per array entry so it runs unchanged on
 * Cloudflare D1 and on Node's SQLite.
 *
 * Three groups of tables:
 *   1. Mock commerce platform and payment gateway (stand-ins for the client's systems,
 *      only ever touched through the CommercePort / PaymentPort adapters).
 *   2. The agent's own ledger: actions, escalations, and per-order / per-line counters.
 *   3. Conversation state, audit log, notifications and rate limits.
 *
 * Money safety does not rely on application code alone. The CHECK constraints on
 * `ledger_orders` and `ledger_lines` make the database itself refuse to record more
 * refunded than was paid, or more units actioned than were bought, and the partial
 * unique index on `actions.idempotency_key` makes it refuse a second live action for
 * the same request.
 */

export const SCHEMA_VERSION = "1";

export const TABLES = [
  "meta",
  "counters",
  "customers",
  "products",
  "inventory",
  "orders",
  "order_items",
  "exchanges",
  "gateway_refunds",
  "ledger_orders",
  "ledger_lines",
  "actions",
  "escalations",
  "risk_events",
  "messages",
  "audit_log",
  "notifications",
  "rate_limits",
] as const;

export const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)`,

  // --- 1. Mock commerce platform ------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS customers (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     email TEXT NOT NULL UNIQUE
   )`,
  `CREATE TABLE IF NOT EXISTS products (
     sku TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     category TEXT NOT NULL,
     price_cents INTEGER NOT NULL,
     sale_price_cents INTEGER,
     hygiene INTEGER NOT NULL DEFAULT 0,
     description TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS inventory (
     sku TEXT NOT NULL,
     size TEXT NOT NULL,
     colour TEXT NOT NULL,
     stock INTEGER NOT NULL CHECK (stock >= 0),
     PRIMARY KEY (sku, size, colour)
   )`,
  `CREATE TABLE IF NOT EXISTS orders (
     id TEXT PRIMARY KEY,
     customer_id TEXT,
     guest_email TEXT,
     status TEXT NOT NULL CHECK (status IN ('processing','shipped','delivered','cancelled')),
     placed_at TEXT NOT NULL,
     shipped_at TEXT,
     delivered_at TEXT,
     cancelled_at TEXT,
     shipping_cents INTEGER NOT NULL,
     total_paid_cents INTEGER NOT NULL,
     currency TEXT NOT NULL,
     payment_method TEXT NOT NULL,
     payment_ref TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS orders_by_customer ON orders (customer_id)`,
  `CREATE INDEX IF NOT EXISTS orders_by_guest ON orders (guest_email)`,
  `CREATE TABLE IF NOT EXISTS order_items (
     id TEXT PRIMARY KEY,
     order_id TEXT NOT NULL,
     line_no INTEGER NOT NULL,
     sku TEXT NOT NULL,
     name TEXT NOT NULL,
     size TEXT NOT NULL,
     colour TEXT NOT NULL,
     qty INTEGER NOT NULL CHECK (qty > 0),
     unit_paid_cents INTEGER NOT NULL CHECK (unit_paid_cents >= 0),
     purchased_on_sale INTEGER NOT NULL,
     hygiene INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS order_items_by_order ON order_items (order_id)`,
  `CREATE TABLE IF NOT EXISTS exchanges (
     reference TEXT PRIMARY KEY,
     idempotency_key TEXT NOT NULL UNIQUE,
     order_id TEXT NOT NULL,
     line_id TEXT NOT NULL,
     sku TEXT NOT NULL,
     size TEXT NOT NULL,
     colour TEXT NOT NULL,
     qty INTEGER NOT NULL,
     created_at TEXT NOT NULL
   )`,

  // --- Mock payment gateway -----------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS gateway_refunds (
     reference TEXT PRIMARY KEY,
     idempotency_key TEXT NOT NULL UNIQUE,
     payment_ref TEXT NOT NULL,
     order_id TEXT NOT NULL,
     amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
     currency TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,

  // --- 2. Agent ledger ----------------------------------------------------------------
  `CREATE TABLE IF NOT EXISTS ledger_orders (
     order_id TEXT PRIMARY KEY,
     paid_cents INTEGER NOT NULL,
     refunded_cents INTEGER NOT NULL DEFAULT 0,
     CHECK (refunded_cents >= 0 AND refunded_cents <= paid_cents)
   )`,
  `CREATE TABLE IF NOT EXISTS ledger_lines (
     line_id TEXT PRIMARY KEY,
     order_id TEXT NOT NULL,
     qty INTEGER NOT NULL,
     refunded_qty INTEGER NOT NULL DEFAULT 0,
     exchanged_qty INTEGER NOT NULL DEFAULT 0,
     CHECK (refunded_qty >= 0 AND exchanged_qty >= 0 AND refunded_qty + exchanged_qty <= qty)
   )`,
  `CREATE TABLE IF NOT EXISTS actions (
     id TEXT PRIMARY KEY,
     type TEXT NOT NULL CHECK (type IN ('refund','exchange','cancellation')),
     status TEXT NOT NULL CHECK (status IN ('pending','executed','failed')),
     customer_key TEXT NOT NULL,
     order_id TEXT NOT NULL,
     line_id TEXT,
     qty INTEGER NOT NULL,
     amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
     currency TEXT NOT NULL,
     reason TEXT,
     idempotency_key TEXT NOT NULL,
     codes TEXT NOT NULL,
     policy_version TEXT NOT NULL,
     origin TEXT NOT NULL CHECK (origin IN ('agent','human','seed')),
     approved_by TEXT,
     escalation_id TEXT,
     external_ref TEXT,
     details TEXT NOT NULL,
     trace_id TEXT NOT NULL,
     local_day TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS actions_live_idempotency
     ON actions (idempotency_key) WHERE status IN ('pending','executed')`,
  `CREATE INDEX IF NOT EXISTS actions_by_customer ON actions (customer_key, created_at)`,
  `CREATE INDEX IF NOT EXISTS actions_by_order ON actions (order_id)`,
  `CREATE INDEX IF NOT EXISTS actions_by_day ON actions (local_day)`,
  `CREATE TABLE IF NOT EXISTS escalations (
     id TEXT PRIMARY KEY,
     status TEXT NOT NULL CHECK (status IN ('open','approved','rejected','resolved')),
     priority TEXT NOT NULL CHECK (priority IN ('P1','P2','P3')),
     category TEXT NOT NULL,
     codes TEXT NOT NULL,
     customer_key TEXT NOT NULL,
     order_id TEXT,
     line_id TEXT,
     proposed_action TEXT,
     summary TEXT NOT NULL,
     risk_snapshot TEXT NOT NULL,
     dedupe_key TEXT NOT NULL,
     sla_due_at TEXT NOT NULL,
     decided_by TEXT,
     decided_at TEXT,
     decision_note TEXT,
     result_action_id TEXT,
     conversation_id TEXT NOT NULL,
     trace_id TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS escalations_open_dedupe
     ON escalations (dedupe_key) WHERE status = 'open'`,
  `CREATE INDEX IF NOT EXISTS escalations_by_customer ON escalations (customer_key, created_at)`,
  `CREATE INDEX IF NOT EXISTS escalations_by_status ON escalations (status, priority, sla_due_at)`,
  `CREATE TABLE IF NOT EXISTS risk_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     customer_key TEXT NOT NULL,
     kind TEXT NOT NULL,
     detail TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS risk_events_by_customer ON risk_events (customer_key, created_at)`,

  // --- 3. Conversation state, audit, notifications ------------------------------------
  `CREATE TABLE IF NOT EXISTS messages (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     conversation_id TEXT NOT NULL,
     customer_key TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('user','assistant')),
     content TEXT NOT NULL,
     trace_id TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages (conversation_id, id)`,
  `CREATE TABLE IF NOT EXISTS audit_log (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     chain_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     ts TEXT NOT NULL,
     trace_id TEXT NOT NULL,
     event TEXT NOT NULL,
     data TEXT NOT NULL,
     prev_hash TEXT NOT NULL,
     hash TEXT NOT NULL,
     UNIQUE (chain_id, seq)
   )`,
  `CREATE INDEX IF NOT EXISTS audit_by_trace ON audit_log (trace_id)`,
  // The audit log is append-only: the database rejects edits and deletions.
  `CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
     BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END`,
  `CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
     BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END`,
  `CREATE TABLE IF NOT EXISTS notifications (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     priority TEXT NOT NULL,
     title TEXT NOT NULL,
     body TEXT NOT NULL,
     fields TEXT NOT NULL,
     delivery TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
     key TEXT PRIMARY KEY,
     window_start INTEGER NOT NULL,
     count INTEGER NOT NULL
   )`,

  `INSERT OR IGNORE INTO counters (name, value) VALUES ('ACT', 0)`,
  `INSERT OR IGNORE INTO counters (name, value) VALUES ('ESC', 0)`,
  `INSERT OR IGNORE INTO counters (name, value) VALUES ('RFND', 0)`,
  `INSERT OR IGNORE INTO counters (name, value) VALUES ('EXCH', 0)`,
  `INSERT OR IGNORE INTO counters (name, value) VALUES ('CANC', 0)`,
];
