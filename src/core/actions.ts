/**
 * Action service: the single path by which a refund, exchange or cancellation can happen.
 *
 *   proposal -> load facts -> Money Gate -> ALLOW        -> execute
 *                                        -> NEEDS_HUMAN  -> open a review ticket
 *                                        -> DENY         -> explain, offer alternatives
 *                                        -> DUPLICATE    -> return what already exists
 *
 * Execution is "reserve, call out, commit":
 *   1. In one database transaction, insert the action as `pending` and reserve the units
 *      and money on the ledger. Constraints make this step fail if the same request is
 *      already live (UNIQUE idempotency key) or if it would exceed what was bought or
 *      paid (CHECK). Nothing has left the building yet.
 *   2. Call the payment gateway / order system, passing the same idempotency key.
 *   3. Mark the action `executed`, or on failure mark it `failed`, release the
 *      reservation and raise an urgent ticket. A crash between 1 and 3 leaves a `pending`
 *      row that still holds its reservation, so the failure mode is "a human must look",
 *      never "paid twice". `npm run reconcile` lists such rows.
 *
 * Human approvals run through the same executor, so there is one code path for money.
 */

import type { TenantConfig } from "../config/tenant.ts";
import type { Clock, CommercePort, PaymentPort, SqlDriver, SqlStatement } from "../ports/index.ts";
import { OrderSystemUnavailable, OutOfStock, isConstraintError } from "../ports/index.ts";
import { nextId } from "../store/ids.ts";
import { getEscalation, toAction, toEscalation, type ActionRow, type EscalationRow } from "../store/ledger.ts";
import { AuditLog } from "./audit.ts";
import type { EscalationService } from "./escalations.ts";
import { evaluate, ownsOrder, type GateContext } from "./gate.ts";
import { assessRisk, type RiskProfile } from "./risk.ts";
import type {
  ActionRecord,
  Decision,
  EscalationRecord,
  Identity,
  Order,
  Proposal,
  TurnAction,
} from "./types.ts";
import { formatMoney, isoDay } from "./util.ts";

const DAY_MS = 86_400_000;

export interface ActionDeps {
  sql: SqlDriver;
  commerce: CommercePort;
  payments: PaymentPort;
  clock: Clock;
  cfg: TenantConfig;
  escalations: EscalationService;
  /** Kill switch, read on every decision. */
  moneyActionsEnabled: () => boolean;
  newTraceId: () => string;
}

/** Mutable state for one customer message, shared by the agent loop and the tools. */
export interface TurnState {
  identity: Identity;
  traceId: string;
  conversationId: string;
  audit: AuditLog;
  /** Everything the customer has typed in this conversation, newest last. */
  customerMessages: string[];
  /** This identity's orders, loaded at most once per turn. */
  orders: Order[] | null;
  actions: TurnAction[];
  duplicates: TurnAction[];
  notices: string[];
  /** Set when the order system could not be reached during this turn. */
  lookupFailed: boolean;
  /** Customer-safe outcome sentences from this turn's tools, used to build a fallback reply. */
  says: string[];
  /** Other customers' order IDs this turn tried to reach (recorded once each). */
  foreignProbes: Set<string>;
}

export type ProposalStatus = "EXECUTED" | "DENIED" | "ESCALATED" | "ALREADY_DONE" | "UNAVAILABLE" | "FAILED";

export interface ProposalOutcome {
  status: ProposalStatus;
  decision: Decision | null;
  action: ActionRecord | null;
  escalation: EscalationRecord | null;
  /** What the model is told. Contains no risk scores, limits or internal codes. */
  forModel: Record<string, unknown>;
}

export interface ApprovalResult {
  ok: boolean;
  code:
    | "APPROVED_AND_EXECUTED"
    | "ACKNOWLEDGED"
    | "REJECTED"
    | "NOT_FOUND"
    | "UNKNOWN_APPROVER"
    | "ALREADY_DECIDED"
    | "APPROVER_LIMIT_EXCEEDED"
    | "NOT_EXECUTABLE"
    | "EXECUTION_FAILED"
    | "SYSTEM_UNAVAILABLE";
  message: string;
  escalation: EscalationRecord | null;
  action: ActionRecord | null;
}

export class ActionService {
  constructor(private readonly deps: ActionDeps) {}

  // --- Facts -----------------------------------------------------------------------

  /** This identity's orders. Cached for the turn; throws OrderSystemUnavailable. */
  async ordersFor(turn: TurnState): Promise<Order[]> {
    if (turn.orders) return turn.orders;
    try {
      turn.orders = await this.deps.commerce.listOrdersFor(turn.identity);
      return turn.orders;
    } catch (err) {
      if (err instanceof OrderSystemUnavailable) turn.lookupFailed = true;
      throw err;
    }
  }

  /**
   * Finds an order only if it belongs to this identity. An ID that exists but belongs
   * to someone else is recorded as a security event and reported as "not found".
   */
  async lookupOrder(orderIdRaw: string, turn: TurnState): Promise<{ order: Order | null; foreign: boolean }> {
    const orderId = orderIdRaw.trim().toUpperCase();
    const owned = await this.ordersFor(turn);
    const mine = owned.find((o) => o.id.toUpperCase() === orderId);
    if (mine) return { order: mine, foreign: false };
    if (turn.identity.kind === "unrecognised") return { order: null, foreign: false };

    let any: Order | null;
    try {
      any = await this.deps.commerce.getOrderById(orderId);
    } catch (err) {
      if (err instanceof OrderSystemUnavailable) turn.lookupFailed = true;
      throw err;
    }
    if (!any) return { order: null, foreign: false };
    if (ownsOrder(turn.identity, any)) return { order: any, foreign: false };

    if (!turn.foreignProbes.has(orderId)) {
      turn.foreignProbes.add(orderId);
      await this.deps.sql.run(
        `INSERT INTO risk_events (customer_key, kind, detail, created_at) VALUES (?, 'ownership_violation', ?, ?)`,
        [turn.identity.key, JSON.stringify({ orderId }), this.deps.clock.now().toISOString()],
      );
      turn.audit.record("security_event", { kind: "ownership_violation", orderId });
    }
    return { order: null, foreign: true };
  }

  /** Loads everything the gate needs for one order in a single database round-trip. */
  async buildContext(
    target: { orderId: string; type: Proposal["type"]; lineId?: string },
    turn: TurnState,
    mode: GateContext["mode"],
  ): Promise<GateContext> {
    const { sql, cfg, clock, commerce } = this.deps;
    const now = clock.now();
    const owned = await this.ordersFor(turn);
    const { order, foreign: foreignOrder } = await this.lookupOrder(target.orderId, turn);

    const orderId = order?.id ?? "";
    const since180 = new Date(now.getTime() - 180 * DAY_MS).toISOString();
    const since30 = new Date(now.getTime() - 30 * DAY_MS).toISOString();
    const [lineRows, orderRow, actionRows, escalationRows, statRows, budgetRows, probeRows] = await sql.batch([
      { sql: `SELECT line_id, refunded_qty, exchanged_qty FROM ledger_lines WHERE order_id = ?`, params: [orderId] },
      { sql: `SELECT refunded_cents FROM ledger_orders WHERE order_id = ?`, params: [orderId] },
      { sql: `SELECT * FROM actions WHERE order_id = ? ORDER BY created_at, id`, params: [orderId] },
      { sql: `SELECT * FROM escalations WHERE order_id = ? ORDER BY created_at, id`, params: [orderId] },
      {
        sql: `SELECT
                COUNT(DISTINCT CASE WHEN type = 'refund' AND status = 'executed' THEN order_id END) AS refunded_orders,
                COALESCE(SUM(CASE WHEN type = 'refund' AND status = 'executed'
                  AND reason IN ('defective_or_damaged','wrong_item_received','not_as_described')
                  AND created_at >= ? THEN 1 ELSE 0 END), 0) AS defect_180d,
                COALESCE(SUM(CASE WHEN type = 'refund' AND status IN ('executed','pending')
                  AND origin = 'agent' AND created_at >= ? THEN 1 ELSE 0 END), 0) AS auto_30d
              FROM actions WHERE customer_key = ?`,
        params: [since180, since30, turn.identity.key],
      },
      {
        sql: `SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM actions
              WHERE type = 'refund' AND origin = 'agent' AND status IN ('executed','pending') AND local_day = ?`,
        params: [isoDay(now, cfg.locale.timeZone)],
      },
      {
        sql: `SELECT COUNT(*) AS n FROM risk_events
              WHERE customer_key = ? AND kind = 'ownership_violation' AND created_at >= ?`,
        params: [turn.identity.key, since30],
      },
    ]);

    const stats = (statRows?.rows[0] ?? {}) as { refunded_orders?: number; defect_180d?: number; auto_30d?: number };
    const risk = assessRisk(
      {
        deliveredOrders: owned.filter((o) => o.status === "delivered").length,
        refundedOrders: Number(stats.refunded_orders ?? 0),
        defectRefunds180d: Number(stats.defect_180d ?? 0),
        autoRefunds30d: Number(stats.auto_30d ?? 0),
        ownershipViolations30d: Number((probeRows?.rows[0] as { n?: number } | undefined)?.n ?? 0),
      },
      cfg,
    );

    const lines = new Map<string, { refundedQty: number; exchangedQty: number }>();
    for (const row of (lineRows?.rows ?? []) as { line_id: string; refunded_qty: number; exchanged_qty: number }[]) {
      lines.set(row.line_id, { refundedQty: row.refunded_qty, exchangedQty: row.exchanged_qty });
    }

    let variants: GateContext["variants"] = null;
    if (order && target.type === "exchange" && mode !== "preview" && target.lineId) {
      const line = order.lines.find((l) => l.id === target.lineId);
      if (line) variants = (await commerce.getProduct(line.sku))?.variants ?? [];
    }

    return {
      now,
      cfg,
      identity: turn.identity,
      order,
      foreignOrder,
      lines,
      orderRefundedCents: Number((orderRow?.rows[0] as { refunded_cents?: number } | undefined)?.refunded_cents ?? 0),
      actions: ((actionRows?.rows ?? []) as unknown as ActionRow[]).map(toAction),
      escalations: ((escalationRows?.rows ?? []) as unknown as EscalationRow[]).map(toEscalation),
      risk,
      usage: {
        autoRefundedTodayCents: Number((budgetRows?.rows[0] as { cents?: number } | undefined)?.cents ?? 0),
        customerAutoRefunds30d: Number(stats.auto_30d ?? 0),
      },
      customerMessages: turn.customerMessages,
      variants,
      moneyActionsEnabled: this.deps.moneyActionsEnabled(),
      mode,
    };
  }

  /**
   * Dry run of the gate for every line of an order, so the model can tell a customer
   * what is possible without doing the date and policy reasoning itself.
   */
  async describeOptions(
    order: Order,
    turn: TurnState,
  ): Promise<{ cancel: string; lines: Record<string, { refund: string; refund_if_faulty: string; exchange: string }> }> {
    const ctx = await this.buildContext({ orderId: order.id, type: "refund" }, turn, "preview");
    const label = (d: Decision): string => {
      switch (d.outcome) {
        case "ALLOW":
          return "available now";
        case "NEEDS_HUMAN":
          return "possible, needs a team review first";
        case "DUPLICATE":
          return `already handled (${d.existingActionId ?? d.existingEscalationId ?? d.publicCode})`;
        case "DENY":
          return `not available: ${d.publicCode}`;
      }
    };
    const lines: Record<string, { refund: string; refund_if_faulty: string; exchange: string }> = {};
    for (const line of order.lines) {
      const base = { orderId: order.id, lineId: line.id };
      lines[line.id] = {
        refund: label(evaluate({ type: "refund", ...base, reason: "changed_mind" }, ctx)),
        refund_if_faulty: label(evaluate({ type: "refund", ...base, reason: "defective_or_damaged" }, ctx)),
        exchange: label(evaluate({ type: "exchange", ...base, reason: "wrong_size_or_fit" }, ctx)),
      };
    }
    return { cancel: label(evaluate({ type: "cancellation", orderId: order.id }, ctx)), lines };
  }

  // --- Proposals from the model ----------------------------------------------------

  async propose(proposal: Proposal, turn: TurnState): Promise<ProposalOutcome> {
    const { cfg } = this.deps;
    turn.audit.record("proposal_received", { proposal });

    let ctx: GateContext;
    try {
      ctx = await this.buildContext(
        { orderId: proposal.orderId, type: proposal.type, lineId: proposal.type === "cancellation" ? undefined : proposal.lineId },
        turn,
        "agent",
      );
    } catch (err) {
      if (!(err instanceof OrderSystemUnavailable)) throw err;
      // Fail closed: without the order there is nothing to verify, so nothing is done.
      turn.audit.record("order_lookup_failed", { during: "proposal", proposal });
      return {
        status: "UNAVAILABLE",
        decision: null,
        action: null,
        escalation: null,
        forModel: {
          outcome: "UNAVAILABLE",
          say: "The order system can't be reached right now, so nothing has been changed. The request is being passed to the team to follow up.",
        },
      };
    }

    const decision = evaluate(proposal, ctx);
    turn.audit.record("gate_decision", {
      proposal,
      outcome: decision.outcome,
      codes: decision.codes,
      amountCents: decision.amountCents,
      qty: decision.qty,
      idempotencyKey: decision.idempotencyKey,
      facts: decision.facts,
      risk: { tier: ctx.risk.tier, signals: ctx.risk.signals },
      policyVersion: cfg.policy.version,
    });

    switch (decision.outcome) {
      case "ALLOW":
        return this.execute(proposal, decision, ctx.order!, turn, { origin: "agent", approvedBy: null, escalationId: null }, ctx.risk);

      case "NEEDS_HUMAN": {
        const order = ctx.order!;
        const line = decision.lineId ? order.lines.find((l) => l.id === decision.lineId) : undefined;
        const { record, created } = await this.deps.escalations.open(
          {
            category: decision.escalationCategory ?? "other",
            priority: decision.priority,
            codes: decision.codes,
            identity: turn.identity,
            orderId: order.id,
            lineId: decision.lineId,
            proposedAction: this.withResolvedTarget(proposal, decision),
            summary: this.reviewSummary(proposal, decision, order, line?.name ?? null, turn),
            riskSnapshot: { tier: ctx.risk.tier, signals: ctx.risk.signals, stats: ctx.risk.stats, facts: decision.facts },
            conversationId: turn.conversationId,
            traceId: turn.traceId,
          },
          turn.audit,
        );
        const asTurn = escalationToTurnAction(record, cfg);
        if (created) turn.actions.push(asTurn);
        else turn.duplicates.push(asTurn);
        return {
          status: created ? "ESCALATED" : "ALREADY_DONE",
          decision,
          action: null,
          escalation: record,
          forModel: {
            outcome: created ? "ESCALATED" : "ALREADY_DONE",
            code: created ? decision.publicCode : "ALREADY_UNDER_REVIEW",
            reference: record.id,
            respond_by: this.deps.escalations.respondBy(record.priority),
            say: `${decision.say} Reference ${record.id}. The team will reply ${this.deps.escalations.respondBy(record.priority)}.`,
            note: "Nothing has been refunded or changed yet. Do not promise the result of the review.",
          },
        };
      }

      case "DUPLICATE": {
        const existingAction = decision.existingActionId ? ctx.actions.find((a) => a.id === decision.existingActionId) : undefined;
        const existingEscalation = decision.existingEscalationId
          ? ctx.escalations.find((e) => e.id === decision.existingEscalationId)
          : undefined;
        if (existingAction) turn.duplicates.push(actionToTurnAction(existingAction, cfg));
        else if (existingEscalation) turn.duplicates.push(escalationToTurnAction(existingEscalation, cfg));
        return {
          status: "ALREADY_DONE",
          decision,
          action: existingAction ?? null,
          escalation: existingEscalation ?? null,
          forModel: {
            outcome: "ALREADY_DONE",
            code: decision.publicCode,
            reference: decision.existingActionId ?? decision.existingEscalationId,
            say: decision.say,
            note: "This is a repeat of something already handled. Nothing new was done.",
          },
        };
      }

      case "DENY":
        return {
          status: "DENIED",
          decision,
          action: null,
          escalation: null,
          forModel: {
            outcome: "DENIED",
            code: decision.publicCode,
            say: decision.say,
            ...(decision.alternatives.length > 0 ? { alternatives: decision.alternatives } : {}),
            ...(decision.hint ? { hint: decision.hint } : {}),
            ...(decision.existingActionId ? { existing_reference: decision.existingActionId } : {}),
          },
        };
    }
  }

  /** The proposal as it will be executed if approved: gate-resolved quantity, amount and variant. */
  private withResolvedTarget(proposal: Proposal, decision: Decision): NonNullable<EscalationRecord["proposedAction"]> {
    const resolved = { ...proposal, amountCents: decision.amountCents, qty: decision.qty };
    if (resolved.type === "exchange") {
      if (decision.facts.newSize) resolved.newSize = String(decision.facts.newSize);
      if (decision.facts.newColour) resolved.newColour = String(decision.facts.newColour);
    }
    if (resolved.type !== "cancellation" && decision.effectiveReason) resolved.reason = decision.effectiveReason;
    return resolved;
  }

  private reviewSummary(proposal: Proposal, decision: Decision, order: Order, itemName: string | null, turn: TurnState): string {
    const sym = this.deps.cfg.locale.currencySymbol;
    const who = turn.identity.name ? `${turn.identity.name} (${turn.identity.key})` : turn.identity.key;
    const what =
      proposal.type === "cancellation"
        ? `cancel order ${order.id}`
        : `${proposal.type} ${decision.qty} x ${itemName ?? proposal.lineId} from order ${order.id}`;
    const money = proposal.type === "exchange" ? "" : ` for ${formatMoney(decision.amountCents, sym)}`;
    const quote =
      proposal.type !== "cancellation" && proposal.evidenceQuote ? ` Customer said: "${proposal.evidenceQuote}".` : "";
    const reason = proposal.type !== "cancellation" ? ` Reason given: ${decision.effectiveReason ?? proposal.reason}.` : "";
    return `${who} asked to ${what}${money}.${reason}${quote} Needs a person because: ${decision.codes.join(", ")}.`;
  }

  // --- Execution -------------------------------------------------------------------

  private pendingRecord(
    id: string,
    proposal: Proposal,
    decision: Decision,
    order: Order,
    turn: Pick<TurnState, "identity" | "traceId">,
    meta: { origin: "agent" | "human"; approvedBy: string | null; escalationId: string | null },
  ): ActionRecord {
    const now = this.deps.clock.now().toISOString();
    const details: Record<string, unknown> = {};
    if (proposal.type !== "cancellation" && proposal.evidenceQuote) details.customerQuote = proposal.evidenceQuote;
    if (proposal.type === "exchange") {
      details.newSize = decision.facts.newSize ?? proposal.newSize ?? null;
      details.newColour = decision.facts.newColour ?? proposal.newColour ?? null;
    }
    if (proposal.type === "cancellation" && proposal.reason) details.customerReason = proposal.reason;
    details.paymentMethod = order.paymentMethod;
    return {
      id,
      type: proposal.type,
      status: "pending",
      customerKey: turn.identity.key,
      orderId: order.id,
      lineId: decision.lineId,
      qty: decision.qty,
      amountCents: decision.amountCents,
      currency: order.currency,
      reason: proposal.type === "cancellation" ? (proposal.reason ?? null) : (decision.effectiveReason ?? proposal.reason),
      idempotencyKey: decision.idempotencyKey!,
      codes: decision.codes,
      policyVersion: this.deps.cfg.policy.version,
      origin: meta.origin,
      approvedBy: meta.approvedBy,
      escalationId: meta.escalationId,
      externalRef: null,
      details,
      traceId: turn.traceId,
      createdAt: now,
      updatedAt: now,
    };
  }

  private insertStatement(a: ActionRecord): SqlStatement {
    return {
      sql: `INSERT INTO actions (id, type, status, customer_key, order_id, line_id, qty, amount_cents, currency, reason,
              idempotency_key, codes, policy_version, origin, approved_by, escalation_id, external_ref, details,
              trace_id, local_day, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        a.id,
        a.type,
        a.status,
        a.customerKey,
        a.orderId,
        a.lineId,
        a.qty,
        a.amountCents,
        a.currency,
        a.reason,
        a.idempotencyKey,
        JSON.stringify(a.codes),
        a.policyVersion,
        a.origin,
        a.approvedBy,
        a.escalationId,
        a.externalRef,
        JSON.stringify(a.details),
        a.traceId,
        isoDay(a.createdAt, this.deps.cfg.locale.timeZone),
        a.createdAt,
        a.updatedAt,
      ],
    };
  }

  /**
   * Executes an ALLOWed decision. `raiseOnFailure` is false for human approvals, where
   * the caller reopens the original ticket instead of raising a second one.
   */
  async execute(
    proposal: Proposal,
    decision: Decision,
    order: Order,
    turn: TurnState,
    meta: { origin: "agent" | "human"; approvedBy: string | null; escalationId: string | null },
    risk: RiskProfile | null,
    raiseOnFailure = true,
  ): Promise<ProposalOutcome> {
    const { sql, cfg, commerce, payments, clock } = this.deps;
    if (decision.outcome !== "ALLOW" || !decision.idempotencyKey) {
      throw new Error("execute() called without an ALLOW decision");
    }
    const sym = cfg.locale.currencySymbol;
    const action = this.pendingRecord(await nextId(sql, "ACT"), proposal, decision, order, turn, meta);
    const line = action.lineId ? order.lines.find((l) => l.id === action.lineId) : undefined;

    // The decision to act is written to the audit log before anything moves.
    turn.audit.record("action_intent", {
      actionId: action.id,
      type: action.type,
      orderId: action.orderId,
      lineId: action.lineId,
      qty: action.qty,
      amountCents: action.amountCents,
      idempotencyKey: action.idempotencyKey,
      origin: action.origin,
      approvedBy: action.approvedBy,
    });
    await turn.audit.flush();

    // --- 1. Reserve -----------------------------------------------------------------
    const reserve: SqlStatement[] = [
      {
        sql: `INSERT OR IGNORE INTO ledger_orders (order_id, paid_cents, refunded_cents) VALUES (?, ?, 0)`,
        params: [order.id, order.totalPaidCents],
      },
    ];
    if (line) {
      reserve.push({
        sql: `INSERT OR IGNORE INTO ledger_lines (line_id, order_id, qty, refunded_qty, exchanged_qty) VALUES (?, ?, ?, 0, 0)`,
        params: [line.id, order.id, line.qty],
      });
    }
    reserve.push(this.insertStatement(action));
    if (action.type === "refund") {
      reserve.push({ sql: `UPDATE ledger_lines SET refunded_qty = refunded_qty + ? WHERE line_id = ?`, params: [action.qty, action.lineId] });
    }
    if (action.type === "exchange") {
      reserve.push({ sql: `UPDATE ledger_lines SET exchanged_qty = exchanged_qty + ? WHERE line_id = ?`, params: [action.qty, action.lineId] });
    }
    if (action.amountCents > 0) {
      reserve.push({ sql: `UPDATE ledger_orders SET refunded_cents = refunded_cents + ? WHERE order_id = ?`, params: [action.amountCents, order.id] });
    }

    try {
      await sql.batch(reserve);
    } catch (err) {
      if (isConstraintError(err, "UNIQUE")) {
        // The same request is already live (a double-submit or a concurrent turn).
        const row = await sql.first<ActionRow>(
          `SELECT * FROM actions WHERE idempotency_key = ? AND status IN ('pending','executed')`,
          [action.idempotencyKey],
        );
        const existing = row ? toAction(row) : null;
        turn.audit.record("duplicate_blocked", { idempotencyKey: action.idempotencyKey, existingActionId: existing?.id ?? null });
        if (existing) turn.duplicates.push(actionToTurnAction(existing, cfg));
        return {
          status: "ALREADY_DONE",
          decision,
          action: existing,
          escalation: null,
          forModel: {
            outcome: "ALREADY_DONE",
            code: "ALREADY_HANDLED",
            reference: existing?.id ?? null,
            say: `This request has already been handled${existing ? ` (reference ${existing.id})` : ""}. Nothing new was done.`,
          },
        };
      }
      if (isConstraintError(err, "CHECK")) {
        // The ledger refused: this would exceed what was bought or paid.
        turn.audit.record("invariant_refused", { actionId: action.id, idempotencyKey: action.idempotencyKey, error: String(err) });
        return {
          status: "DENIED",
          decision,
          action: null,
          escalation: null,
          forModel: {
            outcome: "DENIED",
            code: "NOTHING_LEFT_TO_ACTION",
            say: "This item has already been fully refunded or exchanged, so nothing further can be done on it.",
          },
        };
      }
      throw err;
    }

    // --- 2. Call out, 3. Commit ------------------------------------------------------
    const release: SqlStatement[] = [];
    if (action.type === "refund") {
      release.push({ sql: `UPDATE ledger_lines SET refunded_qty = refunded_qty - ? WHERE line_id = ?`, params: [action.qty, action.lineId] });
    }
    if (action.type === "exchange") {
      release.push({ sql: `UPDATE ledger_lines SET exchanged_qty = exchanged_qty - ? WHERE line_id = ?`, params: [action.qty, action.lineId] });
    }
    if (action.amountCents > 0) {
      release.push({ sql: `UPDATE ledger_orders SET refunded_cents = refunded_cents - ? WHERE order_id = ?`, params: [action.amountCents, order.id] });
    }
    const fail = async (stage: string, error: unknown): Promise<void> => {
      action.status = "failed";
      action.updatedAt = clock.now().toISOString();
      action.details = { ...action.details, failedAt: stage, error: error instanceof Error ? error.message : String(error) };
      await sql.batch([
        {
          sql: `UPDATE actions SET status = 'failed', details = ?, updated_at = ? WHERE id = ?`,
          params: [JSON.stringify(action.details), action.updatedAt, action.id],
        },
        ...release,
      ]);
      turn.audit.record("action_failed", { actionId: action.id, stage, error: action.details.error });
    };

    try {
      if (action.type === "exchange") {
        const target = { newSize: String(action.details.newSize ?? ""), newColour: String(action.details.newColour ?? "") };
        const { reference } = await commerce.createExchange({
          orderId: order.id,
          lineId: action.lineId!,
          sku: line!.sku,
          qty: action.qty,
          ...target,
          idempotencyKey: action.idempotencyKey,
        });
        action.externalRef = reference;
      } else {
        if (action.type === "cancellation" && order.status !== "cancelled") {
          const cancelled = await commerce.cancelOrder(order.id, action.idempotencyKey);
          if (!cancelled.ok) {
            // The order shipped between the check and the cancel. No money has moved.
            await fail("cancel_order", new Error("Order is no longer cancellable"));
            turn.orders = null;
            return {
              status: "DENIED",
              decision,
              action,
              escalation: null,
              forModel: {
                outcome: "DENIED",
                code: "NO_LONGER_CANCELLABLE",
                say: `Order ${order.id} has just moved on to shipping, so it can no longer be cancelled. Once it arrives a return or exchange can be arranged.`,
              },
            };
          }
          action.details = { ...action.details, cancellationRef: cancelled.reference };
        }
        if (action.amountCents > 0) {
          const { reference } = await payments.refund({
            paymentRef: order.paymentRef,
            amountCents: action.amountCents,
            currency: action.currency,
            idempotencyKey: action.idempotencyKey,
            orderId: order.id,
          });
          action.externalRef = reference;
        }
      }
    } catch (err) {
      const stage = err instanceof OutOfStock ? "create_exchange" : action.type === "exchange" ? "create_exchange" : "payment_refund";
      await fail(stage, err);
      turn.orders = null;

      if (err instanceof OutOfStock) {
        return {
          status: "DENIED",
          decision,
          action,
          escalation: null,
          forModel: { outcome: "DENIED", code: "VARIANT_OUT_OF_STOCK", say: "That size and colour has just sold out, so the exchange was not created." },
        };
      }

      // Money could not be sent. Tell the truth and get a person on it urgently.
      let escalation: EscalationRecord | null = null;
      if (raiseOnFailure) {
        const opened = await this.deps.escalations.open(
          {
            category: "payment_failure",
            priority: "P1",
            codes: ["PAYMENT_GATEWAY_FAILED", ...decision.codes],
            identity: turn.identity,
            orderId: order.id,
            lineId: action.lineId,
            proposedAction: this.withResolvedTarget(proposal, decision),
            summary: `${action.type} ${action.id} for order ${order.id} (${formatMoney(action.amountCents, sym)}) failed at the payment gateway after passing every check. ${
              action.type === "cancellation" ? "The order IS cancelled; only the refund is outstanding. " : ""
            }Approve to retry.`,
            riskSnapshot: risk ? { tier: risk.tier, signals: risk.signals } : {},
            conversationId: turn.conversationId,
            traceId: turn.traceId,
          },
          turn.audit,
        );
        escalation = opened.record;
        if (opened.created) turn.actions.push(escalationToTurnAction(opened.record, cfg));
      }
      return {
        status: "FAILED",
        decision,
        action,
        escalation,
        forModel: {
          outcome: "FAILED",
          code: "PAYMENT_NOT_SENT",
          reference: escalation?.id ?? null,
          say: `The refund could not be sent just now, so no money has moved yet. It has been passed to the team as urgent${escalation ? ` (reference ${escalation.id})` : ""} and they will complete it.`,
          note: "Do not say the refund has been issued.",
        },
      };
    }

    action.status = "executed";
    action.updatedAt = clock.now().toISOString();
    await sql.run(`UPDATE actions SET status = 'executed', external_ref = ?, details = ?, updated_at = ? WHERE id = ?`, [
      action.externalRef,
      JSON.stringify(action.details),
      action.updatedAt,
      action.id,
    ]);
    turn.audit.record("action_executed", {
      actionId: action.id,
      type: action.type,
      orderId: action.orderId,
      lineId: action.lineId,
      amountCents: action.amountCents,
      externalRef: action.externalRef,
      origin: action.origin,
      approvedBy: action.approvedBy,
    });
    turn.actions.push(actionToTurnAction(action, cfg));
    turn.orders = null; // order state changed; reload if asked again this turn

    return {
      status: "EXECUTED",
      decision,
      action,
      escalation: null,
      forModel: {
        outcome: "EXECUTED",
        action: action.type,
        reference: action.id,
        order_id: order.id,
        ...(line ? { item: `${line.name} (${line.size}, ${line.colour}) x ${action.qty}` } : {}),
        ...(action.type !== "exchange" ? { amount: formatMoney(action.amountCents, sym), refunded_to: order.paymentMethod } : {}),
        say: `${decision.say} Reference ${action.id}.`,
      },
    };
  }

  // --- Human approval --------------------------------------------------------------

  /**
   * Applies a reviewer's decision to a ticket. Approving a ticket that carries a
   * proposed action executes it through the same executor as the agent uses, after
   * re-checking the hard invariants against current data. Safe to call twice: only the
   * first decision on an open ticket has any effect.
   */
  async decideEscalation(input: {
    escalationId: string;
    decision: "approve" | "reject";
    approverId: string;
    note?: string;
  }): Promise<ApprovalResult> {
    const { sql, cfg, clock } = this.deps;
    const sym = cfg.locale.currencySymbol;
    const escalation = await getEscalation(sql, input.escalationId);
    if (!escalation) return { ok: false, code: "NOT_FOUND", message: "No such ticket.", escalation: null, action: null };

    const role = cfg.escalation.approvers[input.approverId];
    if (!role) {
      return { ok: false, code: "UNKNOWN_APPROVER", message: `${input.approverId} is not an authorised approver.`, escalation, action: null };
    }
    if (escalation.status !== "open") {
      return {
        ok: false,
        code: "ALREADY_DECIDED",
        message: `Ticket ${escalation.id} was already ${escalation.status}${escalation.decidedBy ? ` by ${escalation.decidedBy}` : ""}. Nothing was changed.`,
        escalation,
        action: null,
      };
    }

    const traceId = this.deps.newTraceId();
    const audit = new AuditLog(sql, clock, escalation.conversationId, traceId);
    const nowIso = clock.now().toISOString();
    const note = input.note?.slice(0, 500) ?? null;
    const claim = async (status: "approved" | "rejected" | "resolved", extraNote?: string): Promise<boolean> => {
      // The status guard makes two reviewers deciding at once safe: one wins, one gets ALREADY_DECIDED.
      const result = await sql.run(
        `UPDATE escalations SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = 'open'`,
        [status, input.approverId, nowIso, [note, extraNote].filter(Boolean).join(" ") || null, escalation.id],
      );
      return result.changes === 1;
    };
    const finish = async (result: Omit<ApprovalResult, "escalation">): Promise<ApprovalResult> => {
      audit.record("escalation_decided", {
        escalationId: escalation.id,
        decision: input.decision,
        approverId: input.approverId,
        role,
        note,
        result: result.code,
        actionId: result.action?.id ?? null,
      });
      await audit.flush();
      return { ...result, escalation: await getEscalation(sql, escalation.id) };
    };
    const lost: Omit<ApprovalResult, "escalation"> = {
      ok: false,
      code: "ALREADY_DECIDED",
      message: "Another reviewer decided this ticket first. Nothing was changed.",
      action: null,
    };

    if (input.decision === "reject") {
      if (!(await claim("rejected"))) return finish(lost);
      return finish({ ok: true, code: "REJECTED", message: `Ticket ${escalation.id} rejected. No money was moved.`, action: null });
    }

    const proposed = escalation.proposedAction;
    if (!proposed) {
      if (!(await claim("resolved"))) return finish(lost);
      return finish({ ok: true, code: "ACKNOWLEDGED", message: `Ticket ${escalation.id} marked as handled.`, action: null });
    }

    // Rebuild the customer's identity from the ticket and re-check against live data.
    const identity = await this.identityFromKey(escalation.customerKey);
    const turn: TurnState = {
      identity,
      traceId,
      conversationId: escalation.conversationId,
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
    const { amountCents: _a, qty: proposedQty, ...rest } = proposed;
    const proposal = (rest.type === "cancellation" ? rest : { ...rest, qty: proposedQty || undefined }) as Proposal;

    let ctx: GateContext;
    try {
      ctx = await this.buildContext(
        { orderId: proposal.orderId, type: proposal.type, lineId: proposal.type === "cancellation" ? undefined : proposal.lineId },
        turn,
        "human_approved",
      );
    } catch (err) {
      if (!(err instanceof OrderSystemUnavailable)) throw err;
      return finish({
        ok: false,
        code: "SYSTEM_UNAVAILABLE",
        message: "The order system is unavailable, so the approval could not be applied. The ticket is still open.",
        action: null,
      });
    }

    const decision = evaluate(proposal, ctx);
    audit.record("gate_decision", {
      proposal,
      mode: "human_approved",
      outcome: decision.outcome,
      codes: decision.codes,
      amountCents: decision.amountCents,
      approverId: input.approverId,
    });

    if (decision.outcome !== "ALLOW") {
      // The world changed since the ticket was raised (already refunded, order shipped...).
      if (!(await claim("resolved", `[Not executed: ${decision.codes.join(", ")}]`))) return finish(lost);
      return finish({
        ok: false,
        code: "NOT_EXECUTABLE",
        message: `Not executed: ${decision.say} The ticket has been closed.`,
        action: null,
      });
    }

    const limit = cfg.escalation.approverLimitsCents[role] ?? 0;
    if (decision.amountCents > limit) {
      return finish({
        ok: false,
        code: "APPROVER_LIMIT_EXCEEDED",
        message: `${formatMoney(decision.amountCents, sym)} is above the ${formatMoney(limit, sym)} limit for ${role}. A more senior approver is needed. The ticket is still open.`,
        action: null,
      });
    }

    if (!(await claim("approved"))) return finish(lost);

    const outcome = await this.execute(
      proposal,
      decision,
      ctx.order!,
      turn,
      { origin: "human", approvedBy: input.approverId, escalationId: escalation.id },
      ctx.risk,
      false,
    );

    if (outcome.status === "EXECUTED" && outcome.action) {
      await sql.run(`UPDATE escalations SET result_action_id = ? WHERE id = ?`, [outcome.action.id, escalation.id]);
      return finish({
        ok: true,
        code: "APPROVED_AND_EXECUTED",
        message: `Approved by ${input.approverId}. ${outcome.action.type} ${outcome.action.id} executed${
          outcome.action.type === "exchange" ? "" : ` for ${formatMoney(outcome.action.amountCents, sym)}`
        }.`,
        action: outcome.action,
      });
    }
    if (outcome.status === "ALREADY_DONE") {
      await sql.run(`UPDATE escalations SET result_action_id = ? WHERE id = ?`, [outcome.action?.id ?? null, escalation.id]);
      return finish({
        ok: false,
        code: "NOT_EXECUTABLE",
        message: "This action had already been executed, so nothing new was done. The ticket has been closed.",
        action: outcome.action,
      });
    }
    // Execution failed after approval: put the ticket back so it is not lost.
    await sql.run(
      `UPDATE escalations SET status = 'open', decided_by = NULL, decided_at = NULL, decision_note = ? WHERE id = ?`,
      [`[Approved by ${input.approverId} but execution failed: ${String(outcome.forModel.code ?? outcome.status)}]`, escalation.id],
    );
    return finish({
      ok: false,
      code: "EXECUTION_FAILED",
      message: `Approved, but execution failed (${String(outcome.forModel.code ?? outcome.status)}). No money moved. The ticket is open again.`,
      action: outcome.action,
    });
  }

  private async identityFromKey(key: string): Promise<Identity> {
    if (key.startsWith("cust:")) {
      const customer = await this.deps.commerce.findCustomerById(key.slice(5));
      if (customer) return { key, kind: "customer", customerId: customer.id, email: customer.email, name: customer.name };
    }
    if (key.startsWith("guest:")) {
      return { key, kind: "guest", customerId: null, email: key.slice(6), name: null };
    }
    return { key, kind: "unrecognised", customerId: null, email: null, name: null };
  }
}

// --- Presentation helpers --------------------------------------------------------------

export function actionToTurnAction(a: ActionRecord, cfg: TenantConfig): TurnAction {
  const sym = cfg.locale.currencySymbol;
  const money = a.type === "exchange" ? null : formatMoney(a.amountCents, sym);
  const detail =
    a.type === "refund"
      ? `Refund of ${money} for ${a.qty} unit(s) of ${a.lineId} to ${String(a.details.paymentMethod ?? "the original payment method")}`
      : a.type === "cancellation"
        ? `Order ${a.orderId} cancelled, ${money} refunded to ${String(a.details.paymentMethod ?? "the original payment method")}`
        : `Exchange of ${a.qty} unit(s) of ${a.lineId} for ${String(a.details.newSize ?? "")} ${String(a.details.newColour ?? "")}`.trim();
  return {
    type: a.type,
    id: a.id,
    status: a.status,
    orderId: a.orderId,
    lineId: a.lineId,
    amountCents: a.type === "exchange" ? null : a.amountCents,
    amount: money,
    priority: null,
    category: null,
    reference: a.externalRef,
    detail,
  };
}

export function escalationToTurnAction(e: EscalationRecord, cfg: TenantConfig): TurnAction {
  const sym = cfg.locale.currencySymbol;
  const proposed = e.proposedAction;
  const amountCents = proposed && proposed.type !== "exchange" ? proposed.amountCents : null;
  return {
    type: "escalation",
    id: e.id,
    status: e.status,
    orderId: e.orderId,
    lineId: e.lineId,
    amountCents,
    amount: amountCents !== null ? formatMoney(amountCents, sym) : null,
    priority: e.priority,
    category: e.category,
    reference: null,
    detail: proposed
      ? `Sent to a human to review a proposed ${proposed.type}${amountCents !== null ? ` of ${formatMoney(amountCents, sym)}` : ""}`
      : "Handed over to a human",
  };
}
