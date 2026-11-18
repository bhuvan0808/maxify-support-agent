/**
 * Row mappers and read queries for the agent's ledger tables (actions, escalations).
 * Writes that move money live in `core/actions.ts`, next to the logic that guards them.
 */

import type { SqlDriver } from "../ports/index.ts";
import type { ActionRecord, EscalationRecord } from "../core/types.ts";
import { safeJsonParse } from "../core/util.ts";

export interface ActionRow {
  id: string;
  type: ActionRecord["type"];
  status: ActionRecord["status"];
  customer_key: string;
  order_id: string;
  line_id: string | null;
  qty: number;
  amount_cents: number;
  currency: string;
  reason: string | null;
  idempotency_key: string;
  codes: string;
  policy_version: string;
  origin: ActionRecord["origin"];
  approved_by: string | null;
  escalation_id: string | null;
  external_ref: string | null;
  details: string;
  trace_id: string;
  created_at: string;
  updated_at: string;
}

export function toAction(row: ActionRow): ActionRecord {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    customerKey: row.customer_key,
    orderId: row.order_id,
    lineId: row.line_id,
    qty: row.qty,
    amountCents: row.amount_cents,
    currency: row.currency,
    reason: row.reason,
    idempotencyKey: row.idempotency_key,
    codes: safeJsonParse<string[]>(row.codes, []),
    policyVersion: row.policy_version,
    origin: row.origin,
    approvedBy: row.approved_by,
    escalationId: row.escalation_id,
    externalRef: row.external_ref,
    details: safeJsonParse<Record<string, unknown>>(row.details, {}),
    traceId: row.trace_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface EscalationRow {
  id: string;
  status: EscalationRecord["status"];
  priority: EscalationRecord["priority"];
  category: EscalationRecord["category"];
  codes: string;
  customer_key: string;
  order_id: string | null;
  line_id: string | null;
  proposed_action: string | null;
  summary: string;
  risk_snapshot: string;
  sla_due_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  result_action_id: string | null;
  conversation_id: string;
  trace_id: string;
  created_at: string;
}

export function toEscalation(row: EscalationRow): EscalationRecord {
  return {
    id: row.id,
    status: row.status,
    priority: row.priority,
    category: row.category,
    codes: safeJsonParse<string[]>(row.codes, []),
    customerKey: row.customer_key,
    orderId: row.order_id,
    lineId: row.line_id,
    proposedAction: safeJsonParse<EscalationRecord["proposedAction"]>(row.proposed_action, null),
    summary: row.summary,
    riskSnapshot: safeJsonParse<Record<string, unknown>>(row.risk_snapshot, {}),
    slaDueAt: row.sla_due_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
    resultActionId: row.result_action_id,
    conversationId: row.conversation_id,
    traceId: row.trace_id,
    createdAt: row.created_at,
  };
}

export async function getAction(sql: SqlDriver, id: string): Promise<ActionRecord | null> {
  const row = await sql.first<ActionRow>(`SELECT * FROM actions WHERE id = ?`, [id]);
  return row ? toAction(row) : null;
}

export async function getEscalation(sql: SqlDriver, id: string): Promise<EscalationRecord | null> {
  const row = await sql.first<EscalationRow>(`SELECT * FROM escalations WHERE id = ?`, [id]);
  return row ? toEscalation(row) : null;
}

export async function listEscalations(
  sql: SqlDriver,
  filter: { status?: string; limit?: number } = {},
): Promise<EscalationRecord[]> {
  const limit = Math.min(filter.limit ?? 100, 500);
  const rows = filter.status
    ? await sql.all<EscalationRow>(
        `SELECT * FROM escalations WHERE status = ? ORDER BY priority, sla_due_at LIMIT ${limit}`,
        [filter.status],
      )
    : await sql.all<EscalationRow>(`SELECT * FROM escalations ORDER BY created_at DESC LIMIT ${limit}`);
  return rows.map(toEscalation);
}

export async function listActions(sql: SqlDriver, limit = 100): Promise<ActionRecord[]> {
  const rows = await sql.all<ActionRow>(
    `SELECT * FROM actions ORDER BY created_at DESC, id DESC LIMIT ${Math.min(limit, 500)}`,
  );
  return rows.map(toAction);
}

/** What this customer has had done recently: shown to the model so a repeat is recognised. */
export async function loadCustomerHistory(
  sql: SqlDriver,
  customerKey: string,
): Promise<{ actions: ActionRecord[]; escalations: EscalationRecord[] }> {
  const [actions, escalations] = await sql.batch([
    {
      sql: `SELECT * FROM actions WHERE customer_key = ? AND origin <> 'seed' ORDER BY created_at DESC, id DESC LIMIT 12`,
      params: [customerKey],
    },
    {
      sql: `SELECT * FROM escalations WHERE customer_key = ? ORDER BY created_at DESC, id DESC LIMIT 8`,
      params: [customerKey],
    },
  ]);
  return {
    actions: ((actions?.rows ?? []) as unknown as ActionRow[]).map(toAction),
    escalations: ((escalations?.rows ?? []) as unknown as EscalationRow[]).map(toEscalation),
  };
}
