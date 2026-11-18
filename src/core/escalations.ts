/**
 * Human review queue.
 *
 * A ticket is opened whenever the agent must not act alone: the gate said NEEDS_HUMAN,
 * the model handed over, or a dependency failed. Each ticket carries everything a
 * reviewer needs (customer, order, the exact action proposed, the reason codes, the
 * customer's risk signals) plus a priority and a respond-by time, and triggers a
 * priority notification.
 *
 * Tickets are de-duplicated: while one is open for the same customer, order, item and
 * category, a repeat request returns the existing ticket instead of opening another.
 *
 * Priority is set by code from the category, never by the model.
 */

import type { Priority, TenantConfig } from "../config/tenant.ts";
import type { Clock, NotifierPort, SqlDriver } from "../ports/index.ts";
import { isConstraintError } from "../ports/index.ts";
import { nextId } from "../store/ids.ts";
import { toEscalation, type EscalationRow } from "../store/ledger.ts";
import type { AuditLog } from "./audit.ts";
import type { EscalationCategory, EscalationRecord, Identity } from "./types.ts";
import { formatMoney } from "./util.ts";

/** Default priority per category. The gate may raise it (for example a very large refund). */
export const CATEGORY_PRIORITY: Record<EscalationCategory, Priority> = {
  safety_or_injury: "P1",
  legal_or_chargeback_threat: "P1",
  payment_dispute: "P1",
  payment_failure: "P1",
  budget_exceeded: "P1",
  delivery_problem: "P2",
  privacy_request: "P2",
  defect_verification: "P2",
  statutory_defect_claim: "P2",
  refund_review: "P2",
  risk_review: "P2",
  system_unavailable: "P2",
  automation_paused: "P2",
  complaint: "P3",
  customer_requests_human: "P3",
  agent_failure: "P3",
  other: "P3",
};

const CATEGORY_TITLE: Record<EscalationCategory, string> = {
  safety_or_injury: "Safety or injury report",
  legal_or_chargeback_threat: "Legal or chargeback threat",
  payment_dispute: "Payment dispute",
  payment_failure: "Refund failed at the payment gateway",
  budget_exceeded: "Daily auto-refund budget reached",
  delivery_problem: "Delivery problem",
  privacy_request: "Personal data request (PDPA)",
  defect_verification: "Fault claim to verify",
  statutory_defect_claim: "Fault claim outside return window (Lemon Law)",
  refund_review: "Refund above auto-approval limit",
  risk_review: "Customer risk review",
  system_unavailable: "Order system unavailable",
  automation_paused: "Automation paused: manual handling",
  complaint: "Complaint",
  customer_requests_human: "Customer asked for a person",
  agent_failure: "Assistant could not complete the conversation",
  other: "Needs a person",
};

export interface OpenEscalationInput {
  category: EscalationCategory;
  /** Overrides the category default when the gate decided a higher priority. */
  priority?: Priority | null;
  codes: string[];
  identity: Identity;
  orderId: string | null;
  lineId: string | null;
  proposedAction: EscalationRecord["proposedAction"];
  summary: string;
  riskSnapshot: Record<string, unknown>;
  conversationId: string;
  traceId: string;
}

export class EscalationService {
  constructor(
    private readonly sql: SqlDriver,
    private readonly clock: Clock,
    private readonly cfg: TenantConfig,
    private readonly notifier: NotifierPort,
  ) {}

  /** Human-readable respond-by promise for the customer, by priority. */
  respondBy(priority: Priority): string {
    const minutes = this.cfg.escalation.slaMinutes[priority];
    if (minutes <= 60) return "within the hour";
    if (minutes <= 480) return "within one working day";
    return "within one to two working days";
  }

  async open(input: OpenEscalationInput, audit: AuditLog): Promise<{ record: EscalationRecord; created: boolean }> {
    const priority = input.priority ?? CATEGORY_PRIORITY[input.category];
    const dedupeKey = [input.identity.key, input.orderId ?? "-", input.lineId ?? "-", input.category].join("|");

    const existing = await this.findOpen(dedupeKey);
    if (existing) {
      audit.record("escalation_deduplicated", { escalationId: existing.id, dedupeKey });
      return { record: existing, created: false };
    }

    const id = await nextId(this.sql, "ESC");
    const now = this.clock.now();
    const slaDueAt = new Date(now.getTime() + this.cfg.escalation.slaMinutes[priority] * 60_000).toISOString();
    try {
      await this.sql.run(
        `INSERT INTO escalations (id, status, priority, category, codes, customer_key, order_id, line_id,
           proposed_action, summary, risk_snapshot, dedupe_key, sla_due_at, conversation_id, trace_id, created_at)
         VALUES (?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          priority,
          input.category,
          JSON.stringify(input.codes),
          input.identity.key,
          input.orderId,
          input.lineId,
          input.proposedAction ? JSON.stringify(input.proposedAction) : null,
          input.summary,
          JSON.stringify(input.riskSnapshot),
          dedupeKey,
          slaDueAt,
          input.conversationId,
          input.traceId,
          now.toISOString(),
        ],
      );
    } catch (err) {
      // Lost a race with an identical request: return the ticket that won.
      if (isConstraintError(err, "UNIQUE")) {
        const winner = await this.findOpen(dedupeKey);
        if (winner) return { record: winner, created: false };
      }
      throw err;
    }

    const record = (await this.findOpen(dedupeKey))!;
    audit.record("escalation_opened", {
      escalationId: id,
      priority,
      category: input.category,
      codes: input.codes,
      orderId: input.orderId,
      lineId: input.lineId,
      proposedAction: input.proposedAction,
      slaDueAt,
    });

    const amount = input.proposedAction?.amountCents
      ? ` ${formatMoney(input.proposedAction.amountCents, this.cfg.locale.currencySymbol)}`
      : "";
    await this.notifier.send({
      priority,
      title: `${CATEGORY_TITLE[input.category]}: ${id}${input.orderId ? ` (${input.orderId}${amount})` : ""}`,
      body: input.summary,
      fields: {
        escalationId: id,
        category: input.category,
        customer: input.identity.key,
        orderId: input.orderId,
        lineId: input.lineId,
        codes: input.codes,
        respondBy: slaDueAt,
        risk: input.riskSnapshot,
      },
    });
    audit.record("notification_sent", { escalationId: id, priority });
    return { record, created: true };
  }

  private async findOpen(dedupeKey: string): Promise<EscalationRecord | null> {
    const row = await this.sql.first<EscalationRow>(
      `SELECT * FROM escalations WHERE dedupe_key = ? AND status = 'open'`,
      [dedupeKey],
    );
    return row ? toEscalation(row) : null;
  }
}
