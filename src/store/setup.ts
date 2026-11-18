/**
 * Creates the schema and loads the seed data.
 *
 * `ensureDatabase` is idempotent and cheap: it is safe to call on every CLI run and on
 * every Worker cold start. `resetDatabase` drops everything and seeds again, which is
 * how the demo and the evals get a clean, known starting state.
 */

import type { SqlDriver, SqlStatement } from "../ports/index.ts";
import type { TenantConfig } from "../config/tenant.ts";
import { CUSTOMERS, ORDERS, PRODUCTS } from "../data/seed.ts";
import { isoDay } from "../core/util.ts";
import { SCHEMA, SCHEMA_VERSION, TABLES } from "./schema.ts";

const DAY_MS = 86_400_000;

/** Statements per batch; kept well under D1's per-batch limits. */
const CHUNK = 40;

async function runChunked(sql: SqlDriver, statements: SqlStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += CHUNK) {
    await sql.batch(statements.slice(i, i + CHUNK));
  }
}

/** Creates tables if missing and seeds once. Returns true if it seeded. */
export async function ensureDatabase(sql: SqlDriver, now: Date, cfg: TenantConfig): Promise<boolean> {
  let seededAt: { value: string } | null = null;
  try {
    seededAt = await sql.first<{ value: string }>(`SELECT value FROM meta WHERE key = 'seeded_at'`);
  } catch {
    // The meta table does not exist yet: first run.
  }
  if (seededAt) return false;
  await runChunked(
    sql,
    SCHEMA.map((s) => ({ sql: s })),
  );
  await seed(sql, now, cfg);
  return true;
}

/** Drops every table, recreates the schema and seeds relative to `now`. */
export async function resetDatabase(sql: SqlDriver, now: Date, cfg: TenantConfig): Promise<void> {
  await runChunked(
    sql,
    TABLES.map((t) => ({ sql: `DROP TABLE IF EXISTS ${t}` })),
  );
  await runChunked(
    sql,
    SCHEMA.map((s) => ({ sql: s })),
  );
  await seed(sql, now, cfg);
}

async function seed(sql: SqlDriver, now: Date, cfg: TenantConfig): Promise<void> {
  const statements: SqlStatement[] = [];
  const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * DAY_MS).toISOString();
  const products = new Map(PRODUCTS.map((p) => [p.sku, p]));

  for (const c of CUSTOMERS) {
    statements.push({
      sql: `INSERT INTO customers (id, name, email) VALUES (?, ?, ?)`,
      params: [c.id, c.name, c.email],
    });
  }

  for (const p of PRODUCTS) {
    statements.push({
      sql: `INSERT INTO products (sku, name, category, price_cents, sale_price_cents, hygiene, description)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [p.sku, p.name, p.category, p.priceCents, p.salePriceCents, p.hygiene ? 1 : 0, p.description],
    });
    for (const size of p.sizes) {
      for (const colour of p.colours) {
        const stock = p.outOfStock?.includes(`${size}|${colour}`) ? 0 : 12;
        statements.push({
          sql: `INSERT INTO inventory (sku, size, colour, stock) VALUES (?, ?, ?, ?)`,
          params: [p.sku, size, colour, stock],
        });
      }
    }
  }

  let seedActionNo = 0;
  for (const o of ORDERS) {
    const goods = o.lines.reduce((sum, l) => sum + l.unitPaidCents * l.qty, 0);
    const total = goods + o.shippingCents;
    const deliveredAt = o.deliveredDaysAgo !== undefined ? at(o.deliveredDaysAgo) : null;
    statements.push({
      sql: `INSERT INTO orders (id, customer_id, guest_email, status, placed_at, shipped_at, delivered_at,
              cancelled_at, shipping_cents, total_paid_cents, currency, payment_method, payment_ref)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      params: [
        o.id,
        o.customerId ?? null,
        o.guestEmail ?? null,
        o.status,
        at(o.placedDaysAgo),
        o.shippedDaysAgo !== undefined ? at(o.shippedDaysAgo) : null,
        deliveredAt,
        o.shippingCents,
        total,
        cfg.locale.currency,
        o.paymentMethod,
        `PAY-${o.id.slice(4)}`,
      ],
    });

    o.lines.forEach((l, index) => {
      const product = products.get(l.sku);
      if (!product) throw new Error(`Seed order ${o.id} references unknown SKU ${l.sku}`);
      const lineId = `${o.id}-${index + 1}`;
      statements.push({
        sql: `INSERT INTO order_items (id, order_id, line_no, sku, name, size, colour, qty, unit_paid_cents,
                purchased_on_sale, hygiene)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          lineId,
          o.id,
          index + 1,
          l.sku,
          product.name,
          l.size,
          l.colour,
          l.qty,
          l.unitPaidCents,
          l.onSale ? 1 : 0,
          product.hygiene ? 1 : 0,
        ],
      });

      // Refunds that happened before the agent existed. They are written through the same
      // ledger tables as live refunds so risk scoring and reconciliation see one history.
      if (o.pastRefund && o.deliveredDaysAgo !== undefined) {
        seedActionNo += 1;
        const when = at(o.deliveredDaysAgo - o.pastRefund.daysAfterDelivery);
        const amount = l.unitPaidCents * l.qty;
        const idem = `refund:${lineId}:u0`;
        const reference = `RFND-S${String(seedActionNo).padStart(4, "0")}`;
        statements.push(
          {
            sql: `INSERT OR IGNORE INTO ledger_orders (order_id, paid_cents, refunded_cents) VALUES (?, ?, 0)`,
            params: [o.id, total],
          },
          {
            sql: `INSERT INTO ledger_lines (line_id, order_id, qty, refunded_qty, exchanged_qty) VALUES (?, ?, ?, ?, 0)`,
            params: [lineId, o.id, l.qty, l.qty],
          },
          {
            sql: `UPDATE ledger_orders SET refunded_cents = refunded_cents + ? WHERE order_id = ?`,
            params: [amount, o.id],
          },
          {
            sql: `INSERT INTO actions (id, type, status, customer_key, order_id, line_id, qty, amount_cents, currency,
                    reason, idempotency_key, codes, policy_version, origin, approved_by, escalation_id, external_ref,
                    details, trace_id, local_day, created_at, updated_at)
                  VALUES (?, 'refund', 'executed', ?, ?, ?, ?, ?, ?, ?, ?, '["SEED_HISTORY"]', ?, 'seed', NULL, NULL, ?,
                    '{}', 'seed', ?, ?, ?)`,
            params: [
              `ACT-S${String(seedActionNo).padStart(4, "0")}`,
              o.customerId ? `cust:${o.customerId}` : `guest:${o.guestEmail}`,
              o.id,
              lineId,
              l.qty,
              amount,
              cfg.locale.currency,
              o.pastRefund.reason,
              idem,
              cfg.policy.version,
              reference,
              isoDay(when, cfg.locale.timeZone),
              when,
              when,
            ],
          },
          {
            sql: `INSERT INTO gateway_refunds (reference, idempotency_key, payment_ref, order_id, amount_cents, currency, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
            params: [reference, idem, `PAY-${o.id.slice(4)}`, o.id, amount, cfg.locale.currency, when],
          },
        );
      }
    });
  }

  statements.push(
    { sql: `INSERT INTO meta (key, value) VALUES ('seeded_at', ?)`, params: [now.toISOString()] },
    { sql: `INSERT INTO meta (key, value) VALUES ('schema_version', ?)`, params: [SCHEMA_VERSION] },
  );

  await runChunked(sql, statements);
}
