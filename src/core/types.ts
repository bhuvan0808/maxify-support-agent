/**
 * Domain types shared by every layer.
 *
 * Money is always an integer number of cents. Timestamps are ISO-8601 UTC strings.
 */

import type { Priority } from "../config/tenant.ts";

export type Cents = number;

// --- Catalogue and orders (owned by the client's commerce system) ---------------

export interface ProductVariant {
  size: string;
  colour: string;
  stock: number;
}

export interface Product {
  sku: string;
  name: string;
  category: string;
  /** Regular tax-inclusive price. */
  priceCents: Cents;
  /** Current sale price, or null when the product is not on sale. */
  salePriceCents: Cents | null;
  /** Hygiene goods (socks, underwear, swimwear) are not returnable unless faulty. */
  hygiene: boolean;
  description: string;
  variants: ProductVariant[];
}

export type OrderStatus = "processing" | "shipped" | "delivered" | "cancelled";

export interface OrderLine {
  id: string;
  orderId: string;
  lineNo: number;
  sku: string;
  name: string;
  size: string;
  colour: string;
  qty: number;
  /** What the customer actually paid per unit, after any discount. Refunds are computed from this. */
  unitPaidCents: Cents;
  /** True when the unit was bought at a sale price. Decided at purchase time, not by today's catalogue. */
  purchasedOnSale: boolean;
  hygiene: boolean;
}

export interface Order {
  id: string;
  customerId: string | null;
  guestEmail: string | null;
  status: OrderStatus;
  placedAt: string;
  shippedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  shippingCents: Cents;
  totalPaidCents: Cents;
  currency: string;
  /** Masked display string, e.g. "Visa ending 4242". Never a full card number. */
  paymentMethod: string;
  /** Payment-gateway reference of the original charge; refunds go back to it. */
  paymentRef: string;
  lines: OrderLine[];
}

export interface Customer {
  id: string;
  name: string;
  email: string;
}

// --- Identity ----------------------------------------------------------------------

/**
 * Who the agent is talking to. Supplied by the channel (CLI flag, API field, helpdesk
 * webhook) and resolved once per turn. Tools never accept an identity from the model.
 */
export interface Identity {
  /** Stable key used for state: "cust:C001" or "guest:someone@example.com". */
  key: string;
  kind: "customer" | "guest" | "unrecognised";
  customerId: string | null;
  email: string | null;
  name: string | null;
}

// --- Proposals (what the model may ask for) -----------------------------------------

export const RETURN_REASONS = [
  "changed_mind",
  "wrong_size_or_fit",
  "defective_or_damaged",
  "wrong_item_received",
  "not_as_described",
  "other",
] as const;
export type ReturnReason = (typeof RETURN_REASONS)[number];

/** Reasons where the merchant is at fault. These unlock refunds on sale items, so they must be grounded and verified. */
export const FAULT_REASONS: ReadonlySet<ReturnReason> = new Set([
  "defective_or_damaged",
  "wrong_item_received",
  "not_as_described",
]);

export interface RefundProposal {
  type: "refund";
  orderId: string;
  lineId: string;
  qty?: number;
  reason: ReturnReason;
  /** The customer's own words describing the fault. Checked against the transcript. */
  evidenceQuote?: string;
  /** Required to act on a line that already has an action, so a repeat is never silent. */
  additionalToActionId?: string;
}

export interface ExchangeProposal {
  type: "exchange";
  orderId: string;
  lineId: string;
  qty?: number;
  reason: ReturnReason;
  newSize?: string;
  newColour?: string;
  evidenceQuote?: string;
  additionalToActionId?: string;
}

export interface CancellationProposal {
  type: "cancellation";
  orderId: string;
  reason?: string;
}

export type Proposal = RefundProposal | ExchangeProposal | CancellationProposal;
export type ActionType = Proposal["type"];

// --- Gate decisions ----------------------------------------------------------------

export type GateOutcome = "ALLOW" | "DENY" | "NEEDS_HUMAN" | "DUPLICATE";

export interface Decision {
  outcome: GateOutcome;
  /** Internal reason codes. Full detail goes to the audit log and the review ticket. */
  codes: string[];
  /** Customer-safe code the model is allowed to see (no risk or limit detail). */
  publicCode: string;
  /** Customer-safe explanation the model should relay. */
  say: string;
  /** Other things the customer can do instead. */
  alternatives: string[];
  /** Instruction for the model on what to do next (never shown to the customer as-is). */
  hint: string | null;
  /** Resolved by the gate from order data. The model never supplies amounts. */
  amountCents: Cents;
  qty: number;
  lineId: string | null;
  /** Deterministic key: the same request can never execute twice. */
  idempotencyKey: string | null;
  priority: Priority | null;
  escalationCategory: EscalationCategory | null;
  existingActionId: string | null;
  existingEscalationId: string | null;
  /** The reason actually applied (a fault reason that could not be grounded is downgraded). */
  effectiveReason: ReturnReason | null;
  /** Facts used to reach the decision, for the audit trail. */
  facts: Record<string, unknown>;
}

// --- Ledger records ----------------------------------------------------------------

export type ActionStatus = "pending" | "executed" | "failed";

export interface ActionRecord {
  id: string;
  type: ActionType;
  status: ActionStatus;
  customerKey: string;
  orderId: string;
  lineId: string | null;
  qty: number;
  amountCents: Cents;
  currency: string;
  reason: string | null;
  idempotencyKey: string;
  codes: string[];
  policyVersion: string;
  /** "agent" when auto-executed, "human" when executed on an approver's decision. */
  origin: "agent" | "human" | "seed";
  approvedBy: string | null;
  escalationId: string | null;
  /** Reference returned by the payment gateway or order system. */
  externalRef: string | null;
  details: Record<string, unknown>;
  traceId: string;
  createdAt: string;
  updatedAt: string;
}

export const ESCALATION_CATEGORIES = [
  "safety_or_injury",
  "legal_or_chargeback_threat",
  "payment_dispute",
  "delivery_problem",
  "privacy_request",
  "complaint",
  "customer_requests_human",
  "other",
] as const;
/** Categories the model may choose. */
export type ModelEscalationCategory = (typeof ESCALATION_CATEGORIES)[number];
/** Categories only code can raise. */
export type SystemEscalationCategory =
  | "defect_verification"
  | "statutory_defect_claim"
  | "refund_review"
  | "risk_review"
  | "budget_exceeded"
  | "payment_failure"
  | "system_unavailable"
  | "agent_failure"
  | "automation_paused";
export type EscalationCategory = ModelEscalationCategory | SystemEscalationCategory;

export type EscalationStatus = "open" | "approved" | "rejected" | "resolved";

export interface EscalationRecord {
  id: string;
  status: EscalationStatus;
  priority: Priority;
  category: EscalationCategory;
  codes: string[];
  customerKey: string;
  orderId: string | null;
  lineId: string | null;
  /** The exact action a human is being asked to approve, if any. */
  proposedAction: (Proposal & { amountCents: Cents; qty: number }) | null;
  summary: string;
  /** Risk signals captured when the ticket was raised, for the reviewer. */
  riskSnapshot: Record<string, unknown>;
  slaDueAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  resultActionId: string | null;
  conversationId: string;
  traceId: string;
  createdAt: string;
}

// --- Turn result (what a channel receives) -----------------------------------------

export interface TurnAction {
  type: "refund" | "exchange" | "cancellation" | "escalation";
  id: string;
  status: string;
  orderId: string | null;
  lineId: string | null;
  amountCents: Cents | null;
  /** Formatted amount, e.g. "S$69.00". */
  amount: string | null;
  priority: Priority | null;
  category: string | null;
  reference: string | null;
  detail: string;
}

export interface TurnResult {
  traceId: string;
  conversationId: string;
  reply: string;
  /** Actions newly taken in this turn. Empty when nothing was done. */
  actions: TurnAction[];
  /** Earlier actions this turn's request matched, so a repeat is visibly recognised. */
  duplicatesRecognised: TurnAction[];
  /** Non-fatal conditions worth surfacing to the caller (guard interventions, outages). */
  notices: string[];
}
