/**
 * Command-line entry point: one command, one customer message.
 *
 *   npx tsx src/cli.ts C001 "Where is my order ORD-1004?"
 *   npx tsx src/cli.ts guest.lee@example.com "Can I swap these for a 32?"
 *
 * The first argument is the customer identity (anything containing "@" is a guest
 * email, otherwise a customer ID); the rest is the message. It prints the reply and
 * every action taken. State is kept in a SQLite file (default .data/agent.db), so a
 * request repeated in a later call is recognised.
 *
 * Other modes: --show-data, --reset, --queue, --approve / --reject, --audit-verify,
 * --reconcile. Run with --help for the list.
 */

import { resolve } from "node:path";
import { NodeSqliteDriver } from "./adapters/sql/nodeSqlite.ts";
import { apiKeyFromEnv, clockFromEnv, createApp } from "./app.ts";
import { defaultTenant } from "./config/tenant.ts";
import { InvalidRequest } from "./core/agent.ts";
import { verifyAuditChains } from "./core/audit.ts";
import type { TurnAction } from "./core/types.ts";
import { calendarDaysBetween, formatDay, formatMoney } from "./core/util.ts";
import { CUSTOMERS, GUEST_EMAILS, ORDERS } from "./data/seed.ts";
import { listActions, listEscalations } from "./store/ledger.ts";
import { ensureDatabase, resetDatabase } from "./store/setup.ts";

const HELP = `Customer-support agent

  npx tsx src/cli.ts <customer-id | guest-email> "<message>"

Options
  --customer <id>        customer ID (alternative to the first positional argument)
  --email <address>      guest email (alternative to the first positional argument)
  --conversation <id>    keep separate threads for the same customer
  --json                 print the full result as JSON
  --fail-lookup          make every order lookup fail for this call (same as ORDER_LOOKUP_FAIL=1)
  --fail-payment         make the payment gateway fail for this call (same as PAYMENT_FAIL=1)

Other modes
  --show-data            list seeded customers and orders with days since delivery
  --reset                wipe state and re-seed the data relative to now
  --queue                list human-review tickets
  --approve <ESC-id> --approver <id> [--note "..."]
  --reject  <ESC-id> --approver <id> [--note "..."]
  --audit-verify         recompute the audit log hash chains
  --reconcile            compare the ledger with the payment gateway
`;

interface Args {
  flags: Map<string, string | true>;
  positional: string[];
}

const VALUE_FLAGS = new Set(["customer", "email", "conversation", "approve", "reject", "approver", "note"]);

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (VALUE_FLAGS.has(name) && i + 1 < argv.length) flags.set(name, argv[++i]!);
      else flags.set(name, true);
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function printAction(prefix: string, a: TurnAction): void {
  const parts = [
    `${prefix}: ${a.type}`,
    `id=${a.id}`,
    `status=${a.status}`,
    a.orderId ? `order=${a.orderId}` : null,
    a.lineId ? `item=${a.lineId}` : null,
    a.amount ? `amount=${a.amount}` : null,
    a.priority ? `priority=${a.priority}` : null,
    a.category ? `queue=${a.category}` : null,
    a.reference ? `ref=${a.reference}` : null,
  ].filter(Boolean);
  console.log(parts.join(" | "));
  console.log(`        ${a.detail}`);
}

async function main(): Promise<number> {
  // Keys and settings come from the environment; a local .env file is loaded if present.
  try {
    process.loadEnvFile(resolve(process.cwd(), ".env"));
  } catch {
    // No .env file: rely on the real environment.
  }
  const env = process.env as Record<string, string | undefined>;
  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (flags.has("help") || (positional.length === 0 && flags.size === 0)) {
    console.log(HELP);
    return 0;
  }

  const cfg = defaultTenant;
  const clock = clockFromEnv(env);
  const sql = new NodeSqliteDriver(resolve(process.cwd(), env.AGENT_DB_PATH ?? ".data/agent.db"));
  const sym = cfg.locale.currencySymbol;
  const tz = cfg.locale.timeZone;

  if (flags.has("reset")) {
    await resetDatabase(sql, clock.now(), cfg);
    console.log(`State wiped and data re-seeded relative to ${formatDay(clock.now(), tz)}.`);
    return 0;
  }
  await ensureDatabase(sql, clock.now(), cfg);

  const app = createApp({
    sql,
    env,
    cfg,
    clock,
    faults: { orderLookupFail: flags.has("fail-lookup"), paymentFail: flags.has("fail-payment") },
    onNotify: (n) => console.error(`[notify ${n.priority}] ${n.title}`),
  });

  // --- Inspection and human-review modes ---------------------------------------------
  if (flags.has("show-data")) {
    console.log("Customers");
    for (const c of CUSTOMERS) console.log(`  ${c.id}  ${c.name.padEnd(14)} ${c.email.padEnd(28)} ${c.note}`);
    console.log(`Guests\n  ${GUEST_EMAILS.join("\n  ")}`);
    console.log("\nOrders (live state)");
    const notes = new Map(ORDERS.map((o) => [o.id, o.note]));
    const rows = await sql.all<{ id: string; customer_id: string | null; guest_email: string | null; status: string; delivered_at: string | null; total_paid_cents: number }>(
      `SELECT id, customer_id, guest_email, status, delivered_at, total_paid_cents FROM orders ORDER BY id`,
    );
    for (const o of rows) {
      const age = o.delivered_at ? `delivered ${calendarDaysBetween(o.delivered_at, clock.now(), tz)}d ago` : "";
      console.log(
        `  ${o.id}  ${(o.customer_id ?? o.guest_email ?? "").padEnd(24)} ${o.status.padEnd(10)} ${age.padEnd(20)} ${formatMoney(o.total_paid_cents, sym).padStart(9)}  ${notes.get(o.id) ?? ""}`,
      );
    }
    return 0;
  }

  if (flags.has("queue")) {
    const tickets = await listEscalations(sql, {});
    if (tickets.length === 0) console.log("No review tickets.");
    for (const t of tickets) {
      const proposed = t.proposedAction
        ? `${t.proposedAction.type}${t.proposedAction.type === "exchange" ? "" : ` ${formatMoney(t.proposedAction.amountCents, sym)}`}`
        : "no action attached";
      console.log(`${t.id}  ${t.priority}  ${t.status.padEnd(8)} ${t.category.padEnd(26)} ${t.customerKey.padEnd(12)} ${t.orderId ?? "-"}  ${proposed}`);
      console.log(`    ${t.summary}`);
      if (t.status === "open") console.log(`    respond by ${t.slaDueAt}`);
      else console.log(`    ${t.status} by ${t.decidedBy ?? "-"}${t.resultActionId ? ` -> ${t.resultActionId}` : ""}${t.decisionNote ? ` (${t.decisionNote})` : ""}`);
    }
    return 0;
  }

  const decisionFlag = flags.has("approve") ? "approve" : flags.has("reject") ? "reject" : null;
  if (decisionFlag) {
    const id = flags.get(decisionFlag);
    const approver = flags.get("approver");
    if (typeof id !== "string" || typeof approver !== "string") {
      console.error(`Usage: --${decisionFlag} <ESC-id> --approver <id> [--note "..."]\nApprovers: ${Object.entries(cfg.escalation.approvers).map(([a, r]) => `${a} (${r})`).join(", ")}`);
      return 2;
    }
    const note = flags.get("note");
    const result = await app.actions.decideEscalation({
      escalationId: id.toUpperCase(),
      decision: decisionFlag,
      approverId: approver,
      note: typeof note === "string" ? note : undefined,
    });
    console.log(`${result.code}: ${result.message}`);
    if (result.action) printAction("ACTION", { ...toTurn(result.action, sym) });
    return result.ok ? 0 : 1;
  }

  if (flags.has("audit-verify")) {
    const verdict = await verifyAuditChains(sql);
    console.log(`${verdict.ok ? "OK" : "TAMPERING DETECTED"}: ${verdict.events} events in ${verdict.chains} chains.`);
    for (const b of verdict.broken) console.log(`  chain ${b.chainId} seq ${b.seq}: ${b.problem}`);
    return verdict.ok ? 0 : 1;
  }

  if (flags.has("reconcile")) {
    const ledger = (await listActions(sql, 500)).filter((a) => a.type !== "exchange" && a.amountCents > 0);
    const gateway = await app.payments.listRefunds();
    const byKey = new Map(gateway.map((g) => [g.idempotencyKey, g]));
    const problems: string[] = [];
    for (const a of ledger) {
      const g = byKey.get(a.idempotencyKey);
      if (a.status === "executed" && !g) problems.push(`${a.id} executed in ledger but missing at gateway`);
      if (a.status === "executed" && g && g.amountCents !== a.amountCents) problems.push(`${a.id} amount differs: ledger ${a.amountCents} vs gateway ${g.amountCents}`);
      if (a.status === "failed" && g) problems.push(`${a.id} failed in ledger but the gateway paid ${g.reference}`);
      if (a.status === "pending") problems.push(`${a.id} stuck pending since ${a.createdAt}: needs a human`);
    }
    const executedKeys = new Set(ledger.filter((a) => a.status === "executed").map((a) => a.idempotencyKey));
    for (const g of gateway) if (!executedKeys.has(g.idempotencyKey)) problems.push(`gateway refund ${g.reference} has no executed ledger action`);
    console.log(problems.length === 0 ? `OK: ${gateway.length} gateway refunds match the ledger.` : `MISMATCHES (${problems.length})`);
    for (const p of problems) console.log(`  ${p}`);
    return problems.length === 0 ? 0 : 1;
  }

  // --- A customer message ---------------------------------------------------------------
  let customerId = typeof flags.get("customer") === "string" ? (flags.get("customer") as string) : undefined;
  let guestEmail = typeof flags.get("email") === "string" ? (flags.get("email") as string) : undefined;
  const words = [...positional];
  if (!customerId && !guestEmail) {
    const identity = words.shift();
    if (!identity) {
      console.error("Missing customer identity. Give a customer ID or a guest email as the first argument.");
      return 2;
    }
    if (identity.includes("@")) guestEmail = identity;
    else customerId = identity;
  }
  const message = words.join(" ").trim();
  if (!message) {
    console.error('Missing message. Example: npx tsx src/cli.ts C001 "Where is my order?"');
    return 2;
  }
  if (!apiKeyFromEnv(env).key) {
    console.error("warning: no model API key found (LLM_API_KEY or GROQ_API_KEY). The agent will fall back to a safe reply and a ticket.");
  }

  try {
    const conversation = flags.get("conversation");
    const result = await app.agent.handle({
      customerId,
      guestEmail,
      message,
      conversationId: typeof conversation === "string" ? conversation : undefined,
      channel: "cli",
    });
    if (flags.has("json")) {
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }
    console.log(`REPLY:\n${result.reply}\n`);
    if (result.actions.length === 0) console.log("ACTION: none");
    for (const a of result.actions) printAction("ACTION", a);
    for (const a of result.duplicatesRecognised) printAction("REPEAT RECOGNISED (nothing new done)", a);
    if (result.notices.length > 0) console.log(`NOTICES: ${result.notices.join("; ")}`);
    console.log(`TRACE: ${result.traceId}  MODEL: ${app.llmLabel}`);
    return 0;
  } catch (err) {
    if (err instanceof InvalidRequest) {
      console.error(`Invalid request: ${err.message}`);
      return 2;
    }
    throw err;
  }
}

function toTurn(a: import("./core/types.ts").ActionRecord, sym: string): TurnAction {
  return {
    type: a.type,
    id: a.id,
    status: a.status,
    orderId: a.orderId,
    lineId: a.lineId,
    amountCents: a.type === "exchange" ? null : a.amountCents,
    amount: a.type === "exchange" ? null : formatMoney(a.amountCents, sym),
    priority: null,
    category: null,
    reference: a.externalRef,
    detail: `${a.type} executed on approval by ${a.approvedBy ?? "-"}`,
  };
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : err);
    process.exitCode = 1;
  },
);
