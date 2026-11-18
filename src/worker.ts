/**
 * Cloudflare Worker entry point: the HTTP channel for the agent.
 *
 * This file is only transport. It authenticates the caller, parses the request, builds
 * the same `createApp` the CLI and the evals use, and returns the agent's result. All
 * decisions about money live in `src/core`.
 *
 *   GET  /v1/health                         liveness and which model is configured
 *   GET  /v1/config/public                  branding and theme for the chat widget
 *   POST /v1/chat                           one customer message in, reply + actions out
 *   GET  /v1/admin/escalations              human review queue
 *   POST /v1/admin/escalations/:id/decision approve or reject a ticket
 *   GET  /v1/admin/actions                  action ledger
 *   GET  /v1/admin/notifications            priority notification outbox
 *   GET  /v1/admin/audit                    audit events, by trace or latest
 *   GET  /v1/admin/audit/verify             recompute the audit hash chains
 *   POST /v1/admin/reset                    drop and re-seed the demo data
 *
 * Everything outside /v1 is served from ./public as static assets.
 * Secrets (model key, admin key) are Worker secrets, read from `env` at request time.
 */

import { Hono, type Context } from "hono";
import { D1Driver, type D1DatabaseLike } from "./adapters/sql/d1.ts";
import { createApp, type Env } from "./app.ts";
import { defaultTenant } from "./config/tenant.ts";
import { InvalidRequest } from "./core/agent.ts";
import { verifyAuditChains } from "./core/audit.ts";
import { isTruthyFlag, timingSafeEqual } from "./core/util.ts";
import { CUSTOMERS, GUEST_EMAILS } from "./data/seed.ts";
import { listActions, listEscalations } from "./store/ledger.ts";
import { ensureDatabase, resetDatabase } from "./store/setup.ts";

interface Bindings {
  DB: D1DatabaseLike;
  ASSETS: { fetch(request: Request): Promise<Response> };
  [name: string]: unknown;
}

type Ctx = Context<{ Bindings: Bindings }>;

/** Requests larger than this are rejected before parsing. */
const MAX_BODY_BYTES = 8 * 1024;
/** Chat messages allowed per client IP per minute, on top of the per-identity limit in the agent. */
const IP_LIMIT_PER_MINUTE = 30;

const cfg = defaultTenant;

/** Only string bindings are configuration; DB and ASSETS are objects. */
function stringEnv(bindings: Bindings): Env {
  const env: Env = {};
  for (const [name, value] of Object.entries(bindings)) {
    if (typeof value === "string") env[name] = value;
  }
  return env;
}

let databaseReady = false;

/** Creates and seeds the database on first use. Cheap afterwards (one flag check per isolate). */
async function ready(sql: D1Driver): Promise<void> {
  if (databaseReady) return;
  try {
    await ensureDatabase(sql, new Date(), cfg);
  } catch (err) {
    // Two cold isolates can race to seed. If the seed marker exists the other one won; carry on.
    const seeded = await sql.first(`SELECT value FROM meta WHERE key = 'seeded_at'`).catch(() => null);
    if (!seeded) throw err;
  }
  databaseReady = true;
}

function bearer(c: Ctx): string {
  const header = c.req.header("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

/** Returns a Response when the caller is not an authorised admin, otherwise null. */
function denyUnlessAdmin(c: Ctx, env: Env): Response | null {
  const key = env.ADMIN_API_KEY?.trim();
  if (!key) return c.json({ error: "admin_api_disabled", message: "ADMIN_API_KEY is not configured." }, 503);
  if (!timingSafeEqual(bearer(c), key)) return c.json({ error: "unauthorized" }, 401);
  return null;
}

async function readJson(c: Ctx): Promise<Record<string, unknown> | Response> {
  if (Number(c.req.header("content-length") ?? 0) > MAX_BODY_BYTES) {
    return c.json({ error: "payload_too_large" }, 413);
  }
  const text = await c.req.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return c.json({ error: "payload_too_large" }, 413);
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Fall through to the error below.
  }
  return c.json({ error: "invalid_json", message: "Send a JSON object." }, 400);
}

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

/** Fault injection by request header, honoured only when the deployment explicitly allows it. */
function faultsFrom(c: Ctx, env: Env): { orderLookupFail: boolean; paymentFail: boolean } {
  if (!isTruthyFlag(env.ALLOW_FAULT_INJECTION)) return { orderLookupFail: false, paymentFail: false };
  const wanted = (c.req.header("x-fault-injection") ?? "")
    .toLowerCase()
    .split(",")
    .map((part) => part.trim());
  return { orderLookupFail: wanted.includes("order-lookup"), paymentFail: wanted.includes("payment") };
}

async function withinIpLimit(sql: D1Driver, c: Ctx): Promise<boolean> {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const window = Math.floor(Date.now() / 60_000);
  const row = await sql.first<{ count: number }>(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
       window_start = excluded.window_start
     RETURNING count`,
    [`ip:${ip}`, window],
  );
  return (row?.count ?? 1) <= IP_LIMIT_PER_MINUTE;
}

const api = new Hono<{ Bindings: Bindings }>();

// Security headers on every API response; API responses are never cached.
api.use("/v1/*", async (c, next) => {
  await next();
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "no-referrer");
  c.header("cache-control", "no-store");
  c.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
});

api.onError((err, c) => {
  // Logged for operators (Workers observability). The caller never sees internals.
  console.error("unhandled_error", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  return c.json({ error: "internal_error" }, 500);
});

api.get("/v1/health", async (c) => {
  const env = stringEnv(c.env);
  const sql = new D1Driver(c.env.DB);
  await ready(sql);
  const app = createApp({ sql, env });
  return c.json({
    ok: true,
    llm: app.llmLabel,
    policyVersion: cfg.policy.version,
    time: new Date().toISOString(),
  });
});

api.get("/v1/config/public", (c) => {
  const env = stringEnv(c.env);
  const demo = isTruthyFlag(env.PUBLIC_DEMO);
  return c.json({
    brand: {
      name: cfg.brand.name,
      assistantName: cfg.brand.assistantName,
      supportEmail: cfg.brand.supportEmail,
    },
    theme: cfg.brand.theme,
    themeDark: cfg.brand.themeDark,
    locale: cfg.locale,
    policy: {
      version: cfg.policy.version,
      returnWindowDays: cfg.policy.returnWindowDays,
      statutoryDefectWindowMonths: cfg.policy.statutoryDefectWindowMonths,
    },
    demo: {
      enabled: demo,
      faultInjection: demo && isTruthyFlag(env.ALLOW_FAULT_INJECTION),
      customers: demo ? CUSTOMERS.map((x) => ({ id: x.id, name: x.name, email: x.email, note: x.note })) : [],
      guests: demo ? GUEST_EMAILS : [],
      approvers: demo ? cfg.escalation.approvers : {},
    },
  });
});

api.post("/v1/chat", async (c) => {
  const env = stringEnv(c.env);
  // A helpdesk integration authenticates with CHANNEL_API_KEY. The public demo page cannot hold a secret.
  const channelKey = env.CHANNEL_API_KEY?.trim();
  if (channelKey && !isTruthyFlag(env.PUBLIC_DEMO) && !timingSafeEqual(bearer(c), channelKey)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const body = await readJson(c);
  if (body instanceof Response) return body;

  const sql = new D1Driver(c.env.DB);
  await ready(sql);
  if (!(await withinIpLimit(sql, c))) {
    return c.json({ error: "rate_limited", message: "Too many messages. Please wait a minute." }, 429);
  }

  const app = createApp({ sql, env, enforceRateLimit: true, faults: faultsFrom(c, env) });
  try {
    const result = await app.agent.handle({
      customerId: optionalString(body.customer_id),
      guestEmail: optionalString(body.guest_email),
      message: body.message as string,
      conversationId: optionalString(body.conversation_id),
      channel: optionalString(body.channel) ?? "web",
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof InvalidRequest) return c.json({ error: "invalid_request", message: err.message }, 400);
    throw err;
  }
});

// --- Admin: human review, ledger, audit -------------------------------------------------

api.get("/v1/admin/escalations", async (c) => {
  const env = stringEnv(c.env);
  const denied = denyUnlessAdmin(c, env);
  if (denied) return denied;
  const sql = new D1Driver(c.env.DB);
  await ready(sql);
  const status = c.req.query("status");
  const allowed = ["open", "approved", "rejected", "resolved"];
  const escalations = await listEscalations(sql, { status: status && allowed.includes(status) ? status : undefined });
  return c.json({ escalations });
});

api.post("/v1/admin/escalations/:id/decision", async (c) => {
  const env = stringEnv(c.env);
  const denied = denyUnlessAdmin(c, env);
  if (denied) return denied;
  const body = await readJson(c);
  if (body instanceof Response) return body;
  const decision = body.decision;
  const approverId = optionalString(body.approver_id);
  if ((decision !== "approve" && decision !== "reject") || !approverId) {
    return c.json({ error: "invalid_request", message: 'Send { decision: "approve" | "reject", approver_id, note? }.' }, 400);
  }
  const sql = new D1Driver(c.env.DB);
  await ready(sql);
  const app = createApp({ sql, env, faults: faultsFrom(c, env) });
  const result = await app.actions.decideEscalation({
    escalationId: c.req.param("id").toUpperCase(),
    decision,
    approverId,
    note: optionalString(body.note),
  });
  const status =
    result.ok
      ? 200
      : result.code === "NOT_FOUND"
        ? 404
        : result.code === "UNKNOWN_APPROVER" || result.code === "APPROVER_LIMIT_EXCEEDED"
          ? 403
          : result.code === "SYSTEM_UNAVAILABLE" || result.code === "EXECUTION_FAILED"
            ? 502
            : 409;
  return c.json(result, status);
});

api.get("/v1/admin/actions", async (c) => {
  const env = stringEnv(c.env);
  const denied = denyUnlessAdmin(c, env);
  if (denied) return denied;
  const sql = new D1Driver(c.env.DB);
  await ready(sql);
  return c.json({ actions: await listActions(sql, 200) });
});

api.get("/v1/admin/notifications", async (c) => {
  const env = stringEnv(c.env);
  const denied = denyUnlessAdmin(c, env);
  if (denied) return denied;
  const sql = new D1Driver(c.env.DB);
  await ready(sql);
  const notifications = await sql.all(
    `SELECT id, priority, title, body, fields, delivery, created_at FROM notifications ORDER BY id DESC LIMIT 100`,
  );
  return c.json({ notifications });
});

api.get("/v1/admin/audit/verify", async (c) => {
  const env = stringEnv(c.env);
  const denied = denyUnlessAdmin(c, env);
  if (denied) return denied;
  const sql = new D1Driver(c.env.DB);
  await ready(sql);
  return c.json(await verifyAuditChains(sql));
});

api.get("/v1/admin/audit", async (c) => {
  const env = stringEnv(c.env);
  const denied = denyUnlessAdmin(c, env);
  if (denied) return denied;
  const sql = new D1Driver(c.env.DB);
  await ready(sql);
  const traceId = c.req.query("trace_id")?.trim();
  const columns = `id, chain_id, seq, ts, trace_id, event, data, prev_hash, hash`;
  const events = traceId
    ? await sql.all(`SELECT ${columns} FROM audit_log WHERE trace_id = ? ORDER BY id`, [traceId])
    : await sql.all(`SELECT ${columns} FROM audit_log ORDER BY id DESC LIMIT 100`);
  return c.json({ events });
});

api.post("/v1/admin/reset", async (c) => {
  const env = stringEnv(c.env);
  const denied = denyUnlessAdmin(c, env);
  if (denied) return denied;
  // Deliberately does not call ready(): reset must work even if a first seed was interrupted.
  const sql = new D1Driver(c.env.DB);
  await resetDatabase(sql, new Date(), cfg);
  databaseReady = true;
  return c.json({ ok: true, seededAt: new Date().toISOString() });
});

api.all("/v1/*", (c) => c.json({ error: "not_found" }, 404));

// Anything else is a static asset (the chat page and the ops console).
api.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default { fetch: api.fetch };
