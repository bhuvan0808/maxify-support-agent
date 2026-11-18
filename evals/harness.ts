/**
 * Shared plumbing for the eval suites.
 *
 * Repeatability comes from three things, all set here:
 *   - a fixed clock (FIXED_NOW), so "delivered 30 days ago" means the same thing every run;
 *   - a brand-new in-memory database, freshly seeded, for every single case;
 *   - sequential trace IDs instead of random UUIDs.
 *
 * A case passes only if every one of its criteria passes. Each criterion records what
 * was expected and what was actually observed, and both are written to disk.
 */

import { NodeSqliteDriver } from "../src/adapters/sql/nodeSqlite.ts";
import { createApp, type App, type Env } from "../src/app.ts";
import { defaultTenant } from "../src/config/tenant.ts";
import type { TurnState } from "../src/core/actions.ts";
import { AuditLog, verifyAuditChains } from "../src/core/audit.ts";
import type { LlmPort, SqlDriver } from "../src/ports/index.ts";
import { resetDatabase } from "../src/store/setup.ts";

export const FIXED_NOW = "2026-11-18T04:00:00.000Z";

export interface Criterion {
  name: string;
  expected: unknown;
  actual: unknown;
  pass: boolean;
}

export interface EvalCase {
  id: string;
  /** What can go wrong that this case exists to catch. */
  guards: string;
  run(): Promise<{ criteria: Criterion[]; evidence: Record<string, unknown> }>;
}

export interface Suite {
  name: string;
  /** Model label used in the run folder name. */
  label: string;
  cases: EvalCase[];
  /** Stop starting new cases after this long (live suite only). */
  timeBudgetMs?: number;
  perCaseTimeoutMs?: number;
}

/** Thrown when a case could not be judged for a reason outside the product (provider rate limit, no API key). */
export class EvalInfraError extends Error {
  constructor(
    message: string,
    public readonly evidence: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "EvalInfraError";
  }
}

/** Collects explicit pass/fail criteria for one case. */
export class Checks {
  readonly list: Criterion[] = [];

  eq(name: string, actual: unknown, expected: unknown): void {
    this.list.push({ name, expected, actual, pass: JSON.stringify(actual) === JSON.stringify(expected) });
  }
  ok(name: string, pass: boolean, actual: unknown = pass, expected: unknown = true): void {
    this.list.push({ name, expected, actual, pass });
  }
  has(name: string, actual: unknown[], item: unknown): void {
    this.list.push({ name, expected: `contains ${JSON.stringify(item)}`, actual, pass: actual.includes(item) });
  }
  match(name: string, text: string, pattern: RegExp): void {
    this.list.push({ name, expected: `matches ${pattern}`, actual: text, pass: pattern.test(text) });
  }
  noMatch(name: string, text: string, pattern: RegExp): void {
    this.list.push({ name, expected: `does not match ${pattern}`, actual: text, pass: !pattern.test(text) });
  }
  add(criteria: Criterion[]): void {
    this.list.push(...criteria);
  }
}

export interface World {
  sql: NodeSqliteDriver;
  app: App;
  /** Mutable: a case can flip a fault flag between turns. */
  env: Env;
  clock: { now(): Date };
}

/** A fresh, seeded, isolated world. Nothing is shared between cases. */
export async function makeWorld(options: { env?: Env; llm?: LlmPort } = {}): Promise<World> {
  const sql = new NodeSqliteDriver(":memory:");
  const clock = { now: () => new Date(FIXED_NOW) };
  await resetDatabase(sql, clock.now(), defaultTenant);
  const env: Env = { ...(options.env ?? {}) };
  let n = 0;
  const app = createApp({
    sql,
    env,
    clock,
    llm: options.llm,
    newTraceId: () => `trace-${String(++n).padStart(4, "0")}`,
  });
  return { sql, app, env, clock };
}

/** A second agent instance on the same database, to simulate two requests arriving at once. */
export function secondApp(world: World, llm: LlmPort): App {
  let n = 0;
  return createApp({ sql: world.sql, env: world.env, clock: world.clock, llm, newTraceId: () => `trace-b-${String(++n).padStart(4, "0")}` });
}

export type Who = { customerId?: string; guestEmail?: string };

/** Turn state for calling the gate / action service directly, without a model. */
export async function gateTurn(world: World, who: Who, customerMessages: string[] = []): Promise<TurnState> {
  const identity = await world.app.agent.resolveIdentity(who);
  const conversationId = `${identity.key}#eval`;
  return {
    identity,
    traceId: "trace-gate",
    conversationId,
    audit: new AuditLog(world.sql, world.clock, conversationId, "trace-gate"),
    customerMessages,
    orders: null,
    actions: [],
    duplicates: [],
    notices: [],
    lookupFailed: false,
    says: [],
    foreignProbes: new Set(),
  };
}

type Row = Record<string, any>;

/** Everything the agent wrote, excluding seeded history. This is the evidence the criteria are judged on. */
export async function dump(sql: SqlDriver): Promise<{
  actions: Row[];
  escalations: Row[];
  gatewayRefunds: Row[];
  ledgerOrders: Row[];
  ledgerLines: Row[];
  notifications: Row[];
  riskEvents: Row[];
  cancelledOrders: Row[];
  audit: Row[];
}> {
  const actions = await sql.all<Row>(
    `SELECT id, type, status, customer_key, order_id, line_id, qty, amount_cents, reason, idempotency_key, codes, origin,
            approved_by, escalation_id, external_ref, details
     FROM actions WHERE origin <> 'seed' ORDER BY id`,
  );
  const escalations = await sql.all<Row>(
    `SELECT id, status, priority, category, codes, customer_key, order_id, line_id, proposed_action, summary, decided_by,
            decision_note, result_action_id FROM escalations ORDER BY id`,
  );
  const gatewayRefunds = await sql.all<Row>(
    `SELECT reference, idempotency_key, order_id, amount_cents FROM gateway_refunds WHERE reference NOT LIKE 'RFND-S%' ORDER BY reference`,
  );
  const seeded = `(SELECT order_id FROM actions WHERE origin = 'seed')`;
  const ledgerOrders = await sql.all<Row>(`SELECT * FROM ledger_orders WHERE order_id NOT IN ${seeded} ORDER BY order_id`);
  const ledgerLines = await sql.all<Row>(`SELECT * FROM ledger_lines WHERE order_id NOT IN ${seeded} ORDER BY line_id`);
  const notifications = await sql.all<Row>(`SELECT priority, title, delivery FROM notifications ORDER BY id`);
  const riskEvents = await sql.all<Row>(`SELECT customer_key, kind, detail FROM risk_events ORDER BY id`);
  const cancelledOrders = await sql.all<Row>(`SELECT id, status FROM orders WHERE status = 'cancelled' ORDER BY id`);
  const audit = await sql.all<Row>(`SELECT chain_id, seq, trace_id, event, data FROM audit_log ORDER BY id`);
  return {
    actions: actions.map((a) => ({ ...a, codes: JSON.parse(a.codes), details: JSON.parse(a.details) })),
    escalations: escalations.map((e) => ({
      ...e,
      codes: JSON.parse(e.codes),
      proposed_action: e.proposed_action ? JSON.parse(e.proposed_action) : null,
    })),
    gatewayRefunds,
    ledgerOrders,
    ledgerLines,
    notifications,
    riskEvents,
    cancelledOrders,
    audit: audit.map((a) => ({ ...a, data: JSON.parse(a.data) })),
  };
}

/**
 * Global money-safety invariants, asserted after every case regardless of what the
 * case was about. If any of these fails, money or stock is wrong somewhere.
 */
export async function invariants(sql: SqlDriver): Promise<Criterion[]> {
  const out: Criterion[] = [];

  const orders = await sql.all<Row>(
    `SELECT o.id AS order_id, o.total_paid_cents AS paid,
       (SELECT COALESCE(SUM(a.amount_cents), 0) FROM actions a
         WHERE a.order_id = o.id AND a.status = 'executed' AND a.type IN ('refund','cancellation')) AS refunded
     FROM orders o`,
  );
  const overRefunded = orders.filter((o) => o.refunded > o.paid);
  out.push({ name: "INVARIANT money: per order, executed refunds + cancellations <= total paid", expected: [], actual: overRefunded, pass: overRefunded.length === 0 });

  const lines = await sql.all<Row>(
    `SELECT i.id AS line_id, i.qty,
       (SELECT COALESCE(SUM(a.qty), 0) FROM actions a
         WHERE a.line_id = i.id AND a.status = 'executed' AND a.type IN ('refund','exchange')) AS actioned
     FROM order_items i`,
  );
  const overActioned = lines.filter((l) => l.actioned > l.qty);
  out.push({ name: "INVARIANT units: per line, refunded + exchanged <= quantity bought", expected: [], actual: overActioned, pass: overActioned.length === 0 });

  const ledgerLines = await sql.all<Row>(
    `SELECT l.line_id, l.refunded_qty, l.exchanged_qty,
       (SELECT COALESCE(SUM(a.qty), 0) FROM actions a WHERE a.line_id = l.line_id AND a.type = 'refund' AND a.status IN ('pending','executed')) AS live_refunded,
       (SELECT COALESCE(SUM(a.qty), 0) FROM actions a WHERE a.line_id = l.line_id AND a.type = 'exchange' AND a.status IN ('pending','executed')) AS live_exchanged
     FROM ledger_lines l`,
  );
  const ledgerOrders = await sql.all<Row>(
    `SELECT l.order_id, l.refunded_cents,
       (SELECT COALESCE(SUM(a.amount_cents), 0) FROM actions a WHERE a.order_id = l.order_id AND a.type IN ('refund','cancellation') AND a.status IN ('pending','executed')) AS live_cents
     FROM ledger_orders l`,
  );
  const drift = [
    ...ledgerLines.filter((l) => l.refunded_qty !== l.live_refunded || l.exchanged_qty !== l.live_exchanged),
    ...ledgerOrders.filter((l) => l.refunded_cents !== l.live_cents),
  ];
  out.push({ name: "INVARIANT ledger: reservation counters equal the live actions (failed actions released)", expected: [], actual: drift, pass: drift.length === 0 });

  const unpaid = await sql.all<Row>(
    `SELECT a.id, a.amount_cents, g.amount_cents AS gateway_cents FROM actions a
       LEFT JOIN gateway_refunds g ON g.idempotency_key = a.idempotency_key
     WHERE a.status = 'executed' AND a.type IN ('refund','cancellation') AND a.amount_cents > 0
       AND (g.reference IS NULL OR g.amount_cents <> a.amount_cents)`,
  );
  const unrecorded = await sql.all<Row>(
    `SELECT g.reference, g.amount_cents FROM gateway_refunds g
       LEFT JOIN actions a ON a.idempotency_key = g.idempotency_key AND a.status = 'executed'
     WHERE a.id IS NULL`,
  );
  out.push({
    name: "INVARIANT reconciliation: every executed refund has exactly one gateway refund of the same amount, and the gateway holds nothing the ledger lacks",
    expected: { ledgerNotInGateway: [], gatewayNotInLedger: [] },
    actual: { ledgerNotInGateway: unpaid, gatewayNotInLedger: unrecorded },
    pass: unpaid.length === 0 && unrecorded.length === 0,
  });

  const stuck = await sql.all<Row>(`SELECT id, type FROM actions WHERE status = 'pending'`);
  out.push({ name: "INVARIANT no action left pending", expected: [], actual: stuck, pass: stuck.length === 0 });

  const chains = await verifyAuditChains(sql);
  out.push({ name: "INVARIANT audit log hash chains verify", expected: true, actual: chains.ok ? true : chains.broken, pass: chains.ok });
  return out;
}

export const executed = (db: { actions: Row[] }, type: string): Row[] =>
  db.actions.filter((a) => a.type === type && a.status === "executed");
