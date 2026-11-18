/**
 * The agent: handles one customer message from identity to reply.
 *
 *   1. Resolve identity (from the channel, never from the chat text).
 *   2. Input guardrails: size, redaction, injection signals.
 *   3. Load state: recent conversation and this customer's prior actions and tickets.
 *   4. Model loop: the model reads, calls tools, and drafts a reply. Bounded steps.
 *   5. Deterministic post-conditions: an outage or a model failure always ends in an
 *      honest reply and a ticket, never in a guess or a dropped customer.
 *   6. Output guardrail: the reply must agree with the ledger, or it is replaced.
 *   7. Persist the exchange and flush the audit trail.
 *
 * The model is treated as untrusted throughout. It can be wrong, confused or
 * manipulated; the worst it can then do is say something unhelpful, which step 6
 * catches for the cases that matter.
 */

import type { TenantConfig } from "../config/tenant.ts";
import type { Clock, CommercePort, LlmMessage, LlmPort, SqlDriver } from "../ports/index.ts";
import { loadCustomerHistory } from "../store/ledger.ts";
import type { ActionService, TurnState } from "./actions.ts";
import { escalationToTurnAction } from "./actions.ts";
import { AuditLog } from "./audit.ts";
import type { EscalationService } from "./escalations.ts";
import { checkInput, checkOutput } from "./guards.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { TOOL_SPECS, runTool } from "./tools.ts";
import type { EscalationCategory, Identity, TurnResult } from "./types.ts";
import { stableStringify, truncate } from "./util.ts";

export interface AgentDeps {
  sql: SqlDriver;
  commerce: CommercePort;
  llm: LlmPort;
  clock: Clock;
  cfg: TenantConfig;
  actions: ActionService;
  escalations: EscalationService;
  newTraceId: () => string;
  /** Per-identity message rate limit. On for public HTTP, off for the CLI and evals. */
  enforceRateLimit: boolean;
}

export interface IncomingMessage {
  /** Exactly one of customerId / guestEmail, supplied by the channel. */
  customerId?: string;
  guestEmail?: string;
  message: string;
  /** Optional thread ID from the channel. Scoped to the identity, so it cannot be used to read another customer's thread. */
  conversationId?: string;
  /** Where the message came from, for the audit log (cli, web, zendesk...). */
  channel?: string;
}

export class InvalidRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequest";
  }
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const CUSTOMER_ID = /^[A-Za-z0-9_-]{1,40}$/;

export class SupportAgent {
  constructor(private readonly deps: AgentDeps) {}

  /** Turns what the channel supplied into an Identity. Unknown details are "unrecognised", not an error. */
  async resolveIdentity(input: Pick<IncomingMessage, "customerId" | "guestEmail">): Promise<Identity> {
    const { commerce } = this.deps;
    const id = input.customerId?.trim();
    const email = input.guestEmail?.trim().toLowerCase();
    if (id && email) throw new InvalidRequest("Supply either a customer ID or a guest email, not both.");
    if (id) {
      if (!CUSTOMER_ID.test(id)) throw new InvalidRequest("Customer ID has an invalid format.");
      const customer = await commerce.findCustomerById(id.toUpperCase());
      if (customer) {
        return { key: `cust:${customer.id}`, kind: "customer", customerId: customer.id, email: customer.email.toLowerCase(), name: customer.name };
      }
      return { key: `unknown:${id.toUpperCase()}`, kind: "unrecognised", customerId: null, email: null, name: null };
    }
    if (email) {
      if (!EMAIL.test(email)) throw new InvalidRequest("Guest email has an invalid format.");
      const customer = await commerce.findCustomerByEmail(email);
      if (customer) {
        return { key: `cust:${customer.id}`, kind: "customer", customerId: customer.id, email: customer.email.toLowerCase(), name: customer.name };
      }
      return { key: `guest:${email}`, kind: "guest", customerId: null, email, name: null };
    }
    throw new InvalidRequest("A customer ID or a guest email is required.");
  }

  async handle(input: IncomingMessage): Promise<TurnResult> {
    const { sql, cfg, clock, llm, actions, escalations } = this.deps;
    if (typeof input.message !== "string") throw new InvalidRequest("A message is required.");

    const identity = await this.resolveIdentity(input);
    const traceId = this.deps.newTraceId();
    const thread = (input.conversationId ?? "default").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64) || "default";
    const conversationId = `${identity.key}#${thread}`;
    const audit = new AuditLog(sql, clock, conversationId, traceId);

    const turn: TurnState = {
      identity,
      traceId,
      conversationId,
      audit,
      customerMessages: [],
      orders: null,
      actions: [],
      duplicates: [],
      notices: [],
      lookupFailed: false,
      says: [],
      foreignProbes: new Set(),
    };

    const checked = checkInput(input.message, cfg.agent.maxMessageChars);
    audit.record("message_in", {
      channel: input.channel ?? "unknown",
      identity: { key: identity.key, kind: identity.kind },
      text: checked.text,
      redactions: checked.redactions,
      injectionSignals: checked.injectionSignals,
      truncated: checked.truncated,
    });
    if (checked.redactions.length > 0) turn.notices.push(`input_redacted:${[...new Set(checked.redactions)].join(",")}`);
    if (checked.injectionSignals.length > 0) turn.notices.push(`injection_signals:${checked.injectionSignals.join(",")}`);

    if (checked.text.length === 0) {
      return this.finish(turn, null, "I didn't catch a message there. How can I help with your order today?");
    }

    if (this.deps.enforceRateLimit && !(await this.withinRateLimit(identity.key))) {
      audit.record("rate_limited", { key: identity.key });
      turn.notices.push("rate_limited");
      return this.finish(turn, null, "You're sending messages faster than I can keep up with. Please wait a minute and try again.");
    }

    // --- State ------------------------------------------------------------------------
    const [historyRows, customerHistory] = await Promise.all([
      sql.all<{ role: "user" | "assistant"; content: string }>(
        `SELECT role, content FROM (
           SELECT id, role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?
         ) ORDER BY id ASC`,
        [conversationId, cfg.agent.historyMessages],
      ),
      loadCustomerHistory(sql, identity.key),
    ]);
    turn.customerMessages = [...historyRows.filter((m) => m.role === "user").map((m) => m.content), checked.text];

    const systemPrompt = buildSystemPrompt({ cfg, now: clock.now(), identity, history: customerHistory });
    const messages: LlmMessage[] = [
      { role: "system", content: systemPrompt },
      ...historyRows.map((m) => ({ role: m.role, content: truncate(m.content, 800) }) as LlmMessage),
      { role: "user", content: checked.text },
    ];

    // --- Model loop ---------------------------------------------------------------------
    let reply: string | null = null;
    let modelFailure: string | null = null;
    let toolCallsUsed = 0;
    const toolOutputs: string[] = [];
    const seenCalls = new Map<string, Record<string, unknown>>();

    try {
      for (let step = 1; step <= cfg.agent.maxSteps; step++) {
        const response = await llm.complete({ messages, tools: TOOL_SPECS, maxTokens: cfg.agent.maxReplyTokens });
        audit.record("llm_call", {
          step,
          model: response.model,
          usage: response.usage,
          toolCalls: response.toolCalls.map((c) => ({ name: c.name, arguments: truncate(c.arguments, 600) })),
          content: response.content ? truncate(response.content, 1200) : null,
        });

        if (response.toolCalls.length === 0) {
          reply = response.content?.trim() || null;
          break;
        }

        messages.push({ role: "assistant", content: response.content, toolCalls: response.toolCalls });
        for (const call of response.toolCalls) {
          let result: Record<string, unknown>;
          const signature = `${call.name}:${stableStringify(JSON.parse(safeArgs(call.arguments)))}`;
          const repeated = seenCalls.get(signature);
          if (toolCallsUsed >= cfg.agent.maxToolCalls) {
            result = { error: "TOOL_BUDGET_EXHAUSTED", say: "No more tool calls are allowed for this message. Reply to the customer now." };
          } else if (repeated) {
            // The identical call was already made this turn; do not run it twice.
            result = { ...repeated, note: "Repeat of an earlier call in this turn. Nothing new was done." };
          } else {
            toolCallsUsed += 1;
            const run = await runTool(call.name, call.arguments, turn, {
              cfg,
              commerce: this.deps.commerce,
              actions,
              escalations,
            });
            result = run.result;
            seenCalls.set(signature, result);
            audit.record("tool_call", { step, name: call.name, args: run.args, ignoredArgs: run.ignoredArgs, result });
          }
          const serialised = JSON.stringify(result);
          toolOutputs.push(serialised);
          messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: serialised });
        }
      }
      if (reply === null) modelFailure = "NO_FINAL_REPLY";
    } catch (err) {
      modelFailure = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
    if (modelFailure) {
      audit.record("model_failure", { reason: truncate(modelFailure, 400) });
      turn.notices.push("model_failure");
    }

    // --- Deterministic post-conditions --------------------------------------------------
    const alreadyHandedOver = () => [...turn.actions, ...turn.duplicates].some((a) => a.type === "escalation");

    if (turn.lookupFailed) {
      // The order system is down. Never guess, never leave the customer hanging.
      turn.notices.push("order_lookup_failed");
      const ticket = alreadyHandedOver() ? null : await this.openSystemTicket(turn, "system_unavailable", checked.text);
      const reference = ticket ?? [...turn.actions, ...turn.duplicates].find((a) => a.type === "escalation");
      reply =
        "I'm sorry, I can't reach our order system at the moment, so I haven't been able to look up or change anything on your order. " +
        (reference
          ? `I've passed your request to our team (reference ${reference.id}) and they will follow up ${escalations.respondBy(reference.priority ?? "P2")}. `
          : "") +
        "You're also welcome to try again in a few minutes.";
    } else if (modelFailure) {
      const somethingHappened = turn.actions.length > 0 || turn.duplicates.length > 0;
      const ticket = somethingHappened ? null : await this.openSystemTicket(turn, "agent_failure", checked.text);
      reply = this.safeReply(turn, ticket ? `I've asked a team member to pick this up (reference ${ticket.id}); they will reply ${escalations.respondBy(ticket.priority ?? "P3")}.` : null);
    }

    // --- Output guardrail -----------------------------------------------------------------
    const ownedOrderIds = new Set((turn.orders ?? []).map((o) => o.id.toUpperCase()));
    for (const m of [...turn.customerMessages.join(" ").matchAll(/\bORD-\d{3,}\b/gi)]) ownedOrderIds.add(m[0].toUpperCase());
    for (const m of [...toolOutputs.join(" ").matchAll(/\bORD-\d{3,}\b/gi)]) ownedOrderIds.add(m[0].toUpperCase());
    for (const a of [...customerHistory.actions, ...customerHistory.escalations]) {
      if (a.orderId) ownedOrderIds.add(a.orderId.toUpperCase());
    }
    const priorActionTypes = new Set(customerHistory.actions.filter((a) => a.status === "executed").map((a) => a.type as string));
    const outputContext = {
      turnActions: turn.actions,
      duplicates: turn.duplicates,
      priorActionTypes,
      groundingText: [systemPrompt, checked.text, ...toolOutputs, ...turn.customerMessages].join("\n"),
      allowedOrderIds: ownedOrderIds,
      allowedEmails: new Set([cfg.brand.supportEmail.toLowerCase(), ...(identity.email ? [identity.email.toLowerCase()] : [])]),
    };
    let verdict = checkOutput(reply ?? "", outputContext);
    if (!verdict.ok) {
      audit.record("guard_violation", { violations: verdict.violations, blockedReply: truncate(reply ?? "", 1200) });
      turn.notices.push(`output_guard:${verdict.violations.join(",")}`);
      reply = this.safeReply(turn, null);
      verdict = checkOutput(reply, outputContext);
      if (!verdict.ok) {
        // The fallback is built only from gate text, so this should not happen. Stay safe if it does.
        audit.record("guard_violation", { violations: verdict.violations, stage: "fallback" });
        reply = GENERIC_SAFE_REPLY;
      }
    }

    return this.finish(turn, checked.text, reply ?? GENERIC_SAFE_REPLY);
  }

  /** A reply built only from what the gate and tools actually returned this turn. */
  private safeReply(turn: TurnState, handover: string | null): string {
    const parts = [...new Set(turn.says)];
    if (parts.length === 0) {
      return handover
        ? `I'm sorry, I ran into a problem and couldn't complete that. Nothing has been changed on your orders. ${handover}`
        : GENERIC_SAFE_REPLY;
    }
    return [`Here is where things stand:`, ...parts.map((p) => `- ${p}`), handover ?? ""].filter(Boolean).join("\n");
  }

  private async openSystemTicket(turn: TurnState, category: EscalationCategory, customerText: string) {
    const { record, created } = await this.deps.escalations.open(
      {
        category,
        codes: [category === "system_unavailable" ? "ORDER_SYSTEM_UNAVAILABLE" : "MODEL_FAILURE"],
        identity: turn.identity,
        orderId: null,
        lineId: null,
        proposedAction: null,
        summary:
          category === "system_unavailable"
            ? `The order system was unavailable while helping ${turn.identity.key}. No action was taken. Customer wrote: "${truncate(customerText, 300)}"`
            : `The assistant could not complete a reply for ${turn.identity.key}. Customer wrote: "${truncate(customerText, 300)}"`,
        riskSnapshot: {},
        conversationId: turn.conversationId,
        traceId: turn.traceId,
      },
      turn.audit,
    );
    const asTurn = escalationToTurnAction(record, this.deps.cfg);
    if (created) turn.actions.push(asTurn);
    else turn.duplicates.push(asTurn);
    return asTurn;
  }

  private async withinRateLimit(key: string): Promise<boolean> {
    const window = Math.floor(this.deps.clock.now().getTime() / 60_000);
    const row = await this.deps.sql.first<{ count: number }>(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END,
         window_start = excluded.window_start
       RETURNING count`,
      [key, window],
    );
    return (row?.count ?? 1) <= this.deps.cfg.agent.rateLimitPerMinute;
  }

  /** Persists the exchange, writes the audit trail, and shapes the result for the channel. */
  private async finish(turn: TurnState, userText: string | null, reply: string): Promise<TurnResult> {
    const { sql, clock } = this.deps;
    const now = clock.now().toISOString();
    if (userText !== null) {
      await sql.batch([
        {
          sql: `INSERT INTO messages (conversation_id, customer_key, role, content, trace_id, created_at) VALUES (?, ?, 'user', ?, ?, ?)`,
          params: [turn.conversationId, turn.identity.key, userText, turn.traceId, now],
        },
        {
          sql: `INSERT INTO messages (conversation_id, customer_key, role, content, trace_id, created_at) VALUES (?, ?, 'assistant', ?, ?, ?)`,
          params: [turn.conversationId, turn.identity.key, reply, turn.traceId, now],
        },
      ]);
    }
    turn.audit.record("message_out", {
      reply,
      actions: turn.actions.map((a) => ({ type: a.type, id: a.id, status: a.status, amountCents: a.amountCents })),
      duplicatesRecognised: turn.duplicates.map((a) => a.id),
      notices: turn.notices,
    });
    await turn.audit.flush();
    return {
      traceId: turn.traceId,
      conversationId: turn.conversationId,
      reply,
      actions: turn.actions,
      duplicatesRecognised: turn.duplicates,
      notices: turn.notices,
    };
  }
}

const GENERIC_SAFE_REPLY =
  "I'm sorry, I wasn't able to complete that just now. Nothing has been changed on your orders. Could you tell me a little more about what you need, or would you like me to pass this to a team member?";

/** Tool arguments as JSON text that always parses, for building a call signature. */
function safeArgs(raw: string): string {
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    return JSON.stringify({ unparsable: raw });
  }
}
