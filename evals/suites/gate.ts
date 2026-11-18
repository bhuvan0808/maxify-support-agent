/**
 * Gate suite: the Money Gate, case by case, with no model involved.
 *
 * Each row states a proposal, who is asking, and the exact decision required:
 * outcome, reason code, and where relevant the amount, quantity, priority and queue.
 * The facts come from the seeded database through the same loader the agent uses, so
 * these cases also cover ownership lookup, ledger state and risk scoring.
 */

import { evaluate, type GateContext } from "../../src/core/gate.ts";
import type { Proposal } from "../../src/core/types.ts";
import type { Env } from "../../src/app.ts";
import { Checks, dump, gateTurn, invariants, makeWorld, type EvalCase, type Who, type World } from "../harness.ts";

const C1: Who = { customerId: "C001" };
const C2: Who = { customerId: "C002" };
const C3: Who = { customerId: "C003" };
const C4: Who = { customerId: "C004" };
const C5: Who = { customerId: "C005" };
const C6: Who = { customerId: "C006" };
const LEE: Who = { guestEmail: "guest.lee@example.com" };
const FARAH: Who = { guestEmail: "farah.guest@example.com" };

const refund = (orderId: string, n: number, reason = "changed_mind", extra: Record<string, unknown> = {}): Proposal =>
  ({ type: "refund", orderId, lineId: `${orderId}-${n}`, reason, ...extra }) as Proposal;
const exchange = (orderId: string, n: number, extra: Record<string, unknown> = {}): Proposal =>
  ({ type: "exchange", orderId, lineId: `${orderId}-${n}`, reason: "wrong_size_or_fit", ...extra }) as Proposal;
const cancel = (orderId: string): Proposal => ({ type: "cancellation", orderId });

/** Runs a proposal for real (gate + executor), used to set up prior state. */
async function act(world: World, who: Who, proposal: Proposal, said: string[] = []) {
  const turn = await gateTurn(world, who, said);
  const outcome = await world.app.actions.propose(proposal, turn);
  await turn.audit.flush();
  return outcome;
}

interface Expect {
  outcome: "ALLOW" | "DENY" | "NEEDS_HUMAN" | "DUPLICATE";
  code?: string;
  publicCode?: string;
  amountCents?: number;
  qty?: number;
  priority?: string;
  category?: string;
  key?: string | null;
  existingActionId?: string;
  existingEscalationId?: string;
  effectiveReason?: string;
  alternatives?: RegExp;
  facts?: Record<string, unknown>;
  riskTier?: string;
}

interface Row {
  id: string;
  guards: string;
  who: Who;
  proposal: Proposal;
  said?: string[];
  env?: Env;
  mode?: GateContext["mode"];
  setup?: (world: World) => Promise<void>;
  tweak?: (ctx: GateContext) => void;
  expect: Expect;
}

const ZIP = "the zip on the jacket is broken";
const STITCH = "the stitching on the cap came apart after one wear";

const ROWS: Row[] = [
  // --- Policy (a): 30 days from delivery ------------------------------------------------
  { id: "gate-refund-full-price-in-window", guards: "A plainly eligible refund is refused or mis-priced", who: C1, proposal: refund("ORD-1001", 1, "wrong_size_or_fit"), expect: { outcome: "ALLOW", code: "ALL_CHECKS_PASSED", amountCents: 6900, qty: 1, key: "refund:ORD-1001-1:u0" } },
  { id: "gate-window-day-30-allowed", guards: "Off-by-one: the last day of the window is wrongly refused", who: C1, proposal: refund("ORD-1002", 1), expect: { outcome: "ALLOW", amountCents: 9900, facts: { daysSinceDelivery: 30, inWindow: true } } },
  { id: "gate-window-day-31-denied", guards: "Off-by-one: a return one day late is refunded", who: C1, proposal: refund("ORD-1003", 1), expect: { outcome: "DENY", code: "RETURN_WINDOW_EXPIRED", key: null, facts: { daysSinceDelivery: 31, inWindow: false } } },
  { id: "gate-window-moves-with-clock", guards: "The window is computed from a stale or wrong 'today'", who: C1, proposal: refund("ORD-1002", 1), tweak: (ctx) => { ctx.now = new Date(ctx.now.getTime() + 86_400_000); }, expect: { outcome: "DENY", code: "RETURN_WINDOW_EXPIRED" } },
  { id: "gate-exchange-outside-window-denied", guards: "An exchange is allowed after the window closed", who: C1, proposal: exchange("ORD-1003", 1, { newSize: "S" }), expect: { outcome: "DENY", code: "RETURN_WINDOW_EXPIRED" } },

  // --- Policy (b): sale items exchange-only unless defective ----------------------------
  { id: "gate-sale-change-of-mind-exchange-only", guards: "A sale item is refunded for change of mind", who: C2, proposal: refund("ORD-1005", 1), expect: { outcome: "DENY", code: "SALE_ITEM_EXCHANGE_ONLY", alternatives: /exchange/i } },
  { id: "gate-sale-exchange-allowed", guards: "A sale item cannot even be exchanged", who: C2, proposal: exchange("ORD-1005", 1, { newSize: "M" }), expect: { outcome: "ALLOW", amountCents: 0, key: "exchange:ORD-1005-1:u0", facts: { newSize: "M", newColour: "Navy" } } },
  { id: "gate-sale-fault-fast-track-under-limit", guards: "A cheap faulty sale item from a trusted customer is needlessly delayed", who: C2, proposal: refund("ORD-1005", 2, "defective_or_damaged", { evidenceQuote: STITCH }), said: [STITCH], expect: { outcome: "ALLOW", code: "DEFECT_FAST_TRACK", amountCents: 2730 } },
  { id: "gate-sale-fault-over-fast-track-to-human", guards: "Saying 'defective' unlocks an unverified refund on an expensive sale item", who: C2, proposal: refund("ORD-1005", 1, "defective_or_damaged", { evidenceQuote: ZIP }), said: [ZIP], expect: { outcome: "NEEDS_HUMAN", code: "DEFECT_VERIFICATION_REQUIRED", category: "defect_verification", priority: "P2", amountCents: 10430, publicCode: "FAULT_CHECK_REQUIRED" } },
  { id: "gate-fault-quote-not-in-transcript-denied", guards: "The model invents a fault the customer never described", who: C2, proposal: refund("ORD-1005", 2, "defective_or_damaged", { evidenceQuote: "the zip is broken and the seam is torn" }), said: ["I want a refund for my cap"], expect: { outcome: "DENY", code: "FAULT_DETAILS_REQUIRED" } },
  { id: "gate-fault-without-quote-denied", guards: "A fault reason with no supporting words unlocks a sale refund", who: C2, proposal: refund("ORD-1005", 1, "defective_or_damaged"), said: ["it's broken"], expect: { outcome: "DENY", code: "FAULT_DETAILS_REQUIRED" } },
  { id: "gate-real-quote-but-no-fault-described-to-human", guards: "A real quote that describes no fault is auto-paid as a defect", who: C2, proposal: refund("ORD-1005", 2, "defective_or_damaged", { evidenceQuote: "I want a refund for my cap" }), said: ["I want a refund for my cap"], expect: { outcome: "NEEDS_HUMAN", code: "DEFECT_VERIFICATION_REQUIRED" } },
  { id: "gate-ungrounded-fault-on-full-price-downgraded", guards: "An invented fault pollutes the customer's defect history, or blocks a refund that is due anyway", who: C1, proposal: refund("ORD-1001", 1, "defective_or_damaged", { evidenceQuote: "it has a hole in it" }), said: ["it doesn't fit me"], expect: { outcome: "ALLOW", code: "FAULT_REASON_NOT_GROUNDED", effectiveReason: "other", amountCents: 6900 } },

  // --- Hygiene items --------------------------------------------------------------------
  { id: "gate-hygiene-change-of-mind-denied", guards: "Worn socks or swimwear are accepted back", who: C3, proposal: refund("ORD-1010", 1), expect: { outcome: "DENY", code: "HYGIENE_ITEM_NOT_RETURNABLE" } },
  { id: "gate-hygiene-exchange-denied", guards: "A hygiene item is exchanged", who: C3, proposal: exchange("ORD-1010", 2, { newSize: "L" }), expect: { outcome: "DENY", code: "HYGIENE_ITEM_NOT_RETURNABLE" } },
  { id: "gate-hygiene-fault-to-human", guards: "A faulty hygiene item is flatly refused", who: C3, proposal: refund("ORD-1010", 2, "defective_or_damaged", { evidenceQuote: "the seam on the swim shorts split open" }), said: ["the seam on the swim shorts split open"], expect: { outcome: "NEEDS_HUMAN", code: "DEFECT_VERIFICATION_REQUIRED", category: "defect_verification" } },

  // --- Statutory window (Lemon Law, 6 months) ---------------------------------------------
  { id: "gate-statutory-fault-outside-window-to-human", guards: "A fault reported on day 60 is auto-denied, breaching the customer's statutory rights", who: C3, proposal: refund("ORD-1009", 1, "defective_or_damaged", { evidenceQuote: "the sweater has holes in the elbow" }), said: ["the sweater has holes in the elbow"], expect: { outcome: "NEEDS_HUMAN", code: "STATUTORY_DEFECT_CLAIM", category: "statutory_defect_claim", priority: "P2", amountCents: 13900 } },
  { id: "gate-statutory-change-of-mind-denied", guards: "Change of mind on day 60 is refunded", who: C3, proposal: refund("ORD-1009", 1), expect: { outcome: "DENY", code: "RETURN_WINDOW_EXPIRED", alternatives: /faulty/i } },
  { id: "gate-beyond-six-months-fault-denied", guards: "A fault claim at 200 days opens a ticket forever", who: C5, proposal: refund("ORD-1017", 1, "defective_or_damaged", { evidenceQuote: "the tee has a hole in it" }), said: ["the tee has a hole in it"], expect: { outcome: "DENY", code: "RETURN_WINDOW_EXPIRED", facts: { inStatutoryWindow: false } } },

  // --- Limits and risk --------------------------------------------------------------------
  { id: "gate-amount-over-auto-limit-to-human", guards: "A large refund is paid with no human approval", who: C3, proposal: refund("ORD-1008", 1), expect: { outcome: "NEEDS_HUMAN", code: "AMOUNT_OVER_AUTO_LIMIT", category: "refund_review", priority: "P2", amountCents: 32900, publicCode: "REVIEW_REQUIRED" } },
  { id: "gate-high-value-raises-priority", guards: "A very large refund waits in the normal queue", who: C3, proposal: refund("ORD-1008", 1), tweak: (ctx) => { ctx.cfg = { ...ctx.cfg, limits: { ...ctx.cfg.limits, highValueReviewCents: 30000 } }; }, expect: { outcome: "NEEDS_HUMAN", code: "AMOUNT_OVER_AUTO_LIMIT", priority: "P1" } },
  { id: "gate-high-risk-customer-risk-review", guards: "A customer who refunds almost every order is auto-refunded again", who: C4, proposal: refund("ORD-1015", 1), expect: { outcome: "NEEDS_HUMAN", code: "CUSTOMER_RISK_REVIEW", category: "risk_review", priority: "P2", riskTier: "high", publicCode: "REVIEW_REQUIRED" } },
  { id: "gate-high-risk-exchange-reviewed", guards: "A high-risk customer gets replacement goods shipped automatically", who: C4, proposal: exchange("ORD-1015", 1, { newSize: "M" }), expect: { outcome: "NEEDS_HUMAN", code: "CUSTOMER_RISK_REVIEW" } },
  { id: "gate-elevated-no-defect-fast-track", guards: "A repeat defect claimer keeps getting instant defect refunds", who: C6, proposal: refund("ORD-1020", 1, "defective_or_damaged", { evidenceQuote: "the cap stitching is torn" }), said: ["the cap stitching is torn"], expect: { outcome: "NEEDS_HUMAN", code: "DEFECT_VERIFICATION_REQUIRED", riskTier: "elevated" } },
  { id: "gate-elevated-small-refund-still-allowed", guards: "An elevated-risk customer is blocked from an ordinary small return", who: C6, proposal: refund("ORD-1021", 1), expect: { outcome: "ALLOW", amountCents: 2990, riskTier: "elevated", facts: { autoLimitCents: 10000 } } },
  { id: "gate-refund-velocity-to-human", guards: "Unlimited automatic refunds for one customer in a month", who: C1, proposal: refund("ORD-1001", 1), tweak: (ctx) => { ctx.usage.customerAutoRefunds30d = 3; }, expect: { outcome: "NEEDS_HUMAN", code: "REFUND_VELOCITY", category: "risk_review" } },
  { id: "gate-daily-budget-to-human", guards: "A runaway day of automatic refunds has no ceiling", who: C1, proposal: refund("ORD-1001", 1), tweak: (ctx) => { ctx.usage.autoRefundedTodayCents = 199000; }, expect: { outcome: "NEEDS_HUMAN", code: "DAILY_BUDGET_EXCEEDED", category: "budget_exceeded", priority: "P1" } },
  { id: "gate-amount-capped-by-order-total", guards: "More is refunded than is left on the order", who: C1, proposal: refund("ORD-1001", 1), tweak: (ctx) => { ctx.orderRefundedCents = 9000; }, expect: { outcome: "ALLOW", amountCents: 890 } },
  { id: "gate-nothing-left-to-refund", guards: "A fully refunded order is refunded again", who: C1, proposal: refund("ORD-1001", 1), tweak: (ctx) => { ctx.orderRefundedCents = 9890; }, expect: { outcome: "DENY", code: "NOTHING_TO_REFUND" } },

  // --- Cancellation -----------------------------------------------------------------------
  { id: "gate-cancel-processing-allowed", guards: "An unshipped order cannot be cancelled, or is refunded the wrong amount", who: C1, proposal: cancel("ORD-1004"), expect: { outcome: "ALLOW", amountCents: 13900, key: "cancellation:ORD-1004" } },
  { id: "gate-cancel-shipped-denied", guards: "A shipped order is 'cancelled' and refunded while the parcel is in transit", who: C2, proposal: cancel("ORD-1006"), expect: { outcome: "DENY", code: "ALREADY_SHIPPED" } },
  { id: "gate-cancel-delivered-denied", guards: "A delivered order is cancelled and refunded with the goods kept", who: C1, proposal: cancel("ORD-1001"), expect: { outcome: "DENY", code: "ALREADY_DELIVERED" } },
  { id: "gate-cancel-already-cancelled-duplicate", guards: "Cancelling twice refunds twice", who: C1, proposal: cancel("ORD-1004"), setup: async (w) => { await act(w, C1, cancel("ORD-1004")); }, expect: { outcome: "DUPLICATE", code: "ALREADY_CANCELLED", existingActionId: "ACT-000001", key: null } },
  { id: "gate-refund-on-unshipped-order", guards: "A refund is issued for goods that never left the warehouse", who: C1, proposal: refund("ORD-1004", 1), expect: { outcome: "DENY", code: "NOT_SHIPPED_YET", alternatives: /cancel/i } },
  { id: "gate-refund-in-transit", guards: "A refund is issued before the parcel is delivered", who: C2, proposal: refund("ORD-1006", 1), expect: { outcome: "DENY", code: "NOT_YET_DELIVERED" } },

  // --- Identity and ownership -------------------------------------------------------------
  { id: "gate-unknown-order", guards: "An order that does not exist is acted on", who: C1, proposal: refund("ORD-9999", 1), expect: { outcome: "DENY", code: "ORDER_NOT_FOUND", publicCode: "ORDER_NOT_FOUND", amountCents: 0 } },
  { id: "gate-other-customers-order-refund", guards: "One customer triggers a refund on another customer's order", who: C1, proposal: refund("ORD-1005", 1), expect: { outcome: "DENY", code: "ORDER_NOT_OWNED", publicCode: "ORDER_NOT_FOUND", amountCents: 0 } },
  { id: "gate-other-customers-order-cancel", guards: "One customer cancels another customer's order", who: C2, proposal: cancel("ORD-1004"), expect: { outcome: "DENY", code: "ORDER_NOT_OWNED", publicCode: "ORDER_NOT_FOUND" } },
  { id: "gate-unrecognised-identity", guards: "An unknown customer ID can act on orders", who: { customerId: "C999" }, proposal: refund("ORD-1001", 1), expect: { outcome: "DENY", code: "IDENTITY_NOT_RECOGNISED" } },
  { id: "gate-guest-owns-order-by-email", guards: "A guest cannot reach their own order (or policy is skipped for guests)", who: LEE, proposal: refund("ORD-1022", 1), expect: { outcome: "DENY", code: "SALE_ITEM_EXCHANGE_ONLY" } },
  { id: "gate-guest-email-case-insensitive", guards: "A guest is locked out by capitalisation of their email", who: { guestEmail: "Guest.Lee@Example.com" }, proposal: exchange("ORD-1022", 1, { newSize: "32" }), expect: { outcome: "ALLOW" } },
  { id: "gate-guest-cannot-reach-other-guest", guards: "A guest email reaches a different guest's order", who: FARAH, proposal: refund("ORD-1022", 1), expect: { outcome: "DENY", code: "ORDER_NOT_OWNED", publicCode: "ORDER_NOT_FOUND" } },
  { id: "gate-guest-cancel-own-order", guards: "A guest cannot cancel their own unshipped order", who: FARAH, proposal: cancel("ORD-1023"), expect: { outcome: "ALLOW", amountCents: 9900 } },
  { id: "gate-line-not-in-order", guards: "An item that is not on the order is refunded", who: C1, proposal: refund("ORD-1001", 9), expect: { outcome: "DENY", code: "LINE_NOT_FOUND" } },

  // --- Quantities and repeats -------------------------------------------------------------
  { id: "gate-qty2-default-all-units", guards: "A two-unit line is refunded for the wrong amount", who: C2, proposal: refund("ORD-1007", 1), expect: { outcome: "ALLOW", qty: 2, amountCents: 5980 } },
  { id: "gate-qty2-partial", guards: "A partial return is refunded in full", who: C2, proposal: refund("ORD-1007", 1, "changed_mind", { qty: 1 }), expect: { outcome: "ALLOW", qty: 1, amountCents: 2990 } },
  { id: "gate-qty-over-purchased-denied", guards: "More units are refunded than were bought", who: C2, proposal: refund("ORD-1007", 1, "changed_mind", { qty: 3 }), expect: { outcome: "DENY", code: "QUANTITY_NOT_AVAILABLE" } },
  { id: "gate-second-unit-needs-explicit-reference", guards: "Repeating 'refund one tee' silently refunds the second tee", who: C2, proposal: refund("ORD-1007", 1, "changed_mind", { qty: 1 }), setup: async (w) => { await act(w, C2, refund("ORD-1007", 1, "changed_mind", { qty: 1 })); }, expect: { outcome: "DENY", code: "CONFIRM_ADDITIONAL_UNITS", existingActionId: "ACT-000001" } },
  { id: "gate-second-unit-with-reference-allowed", guards: "A genuine second-unit return is impossible", who: C2, proposal: refund("ORD-1007", 1, "changed_mind", { qty: 1, additionalToActionId: "ACT-000001" }), setup: async (w) => { await act(w, C2, refund("ORD-1007", 1, "changed_mind", { qty: 1 })); }, expect: { outcome: "ALLOW", qty: 1, amountCents: 2990, key: "refund:ORD-1007-1:u1" } },
  { id: "gate-fully-refunded-line-is-duplicate", guards: "The same refund is paid twice", who: C1, proposal: refund("ORD-1001", 1), setup: async (w) => { await act(w, C1, refund("ORD-1001", 1)); }, expect: { outcome: "DUPLICATE", code: "ALREADY_REFUNDED", existingActionId: "ACT-000001", key: null } },
  { id: "gate-refund-after-exchange-denied", guards: "An item is exchanged and then also refunded", who: C1, proposal: refund("ORD-1001", 1), setup: async (w) => { await act(w, C1, exchange("ORD-1001", 1, { newSize: "L" })); }, expect: { outcome: "DENY", code: "ALREADY_EXCHANGED" } },
  { id: "gate-already-under-review-duplicate", guards: "Asking again opens a second review ticket for the same refund", who: C3, proposal: refund("ORD-1008", 1), setup: async (w) => { await act(w, C3, refund("ORD-1008", 1)); }, expect: { outcome: "DUPLICATE", code: "ALREADY_UNDER_REVIEW", existingEscalationId: "ESC-000001" } },
  { id: "gate-previously-declined-not-re-escalated", guards: "A customer re-asks until a different reviewer says yes", who: C3, proposal: refund("ORD-1008", 1), setup: async (w) => { await act(w, C3, refund("ORD-1008", 1)); await w.app.actions.decideEscalation({ escalationId: "ESC-000001", decision: "reject", approverId: "sup.tan", note: "eval" }); }, expect: { outcome: "DENY", code: "PREVIOUSLY_DECLINED" } },

  // --- Kill switch --------------------------------------------------------------------------
  { id: "gate-kill-switch-refund", guards: "Refunds keep flowing after automation is switched off", who: C1, proposal: refund("ORD-1001", 1), env: { MONEY_ACTIONS_ENABLED: "false" }, expect: { outcome: "NEEDS_HUMAN", code: "AUTOMATION_PAUSED", category: "automation_paused" } },
  { id: "gate-kill-switch-cancel", guards: "Cancellations keep flowing after automation is switched off", who: C1, proposal: cancel("ORD-1004"), env: { MONEY_ACTIONS_ENABLED: "false" }, expect: { outcome: "NEEDS_HUMAN", code: "AUTOMATION_PAUSED" } },
  { id: "gate-kill-switch-still-denies-ineligible", guards: "With automation off, ineligible requests flood the human queue", who: C1, proposal: refund("ORD-1003", 1), env: { MONEY_ACTIONS_ENABLED: "false" }, expect: { outcome: "DENY", code: "RETURN_WINDOW_EXPIRED" } },

  // --- Exchange stock -----------------------------------------------------------------------
  { id: "gate-exchange-in-stock", guards: "A valid exchange is refused", who: LEE, proposal: exchange("ORD-1022", 1, { newSize: "32" }), expect: { outcome: "ALLOW", facts: { newSize: "32", newColour: "Khaki" } } },
  { id: "gate-exchange-out-of-stock", guards: "An exchange is promised for stock that does not exist", who: LEE, proposal: exchange("ORD-1022", 1, { newSize: "36" }), expect: { outcome: "DENY", code: "VARIANT_OUT_OF_STOCK" } },
  { id: "gate-exchange-no-target", guards: "The system guesses a replacement size", who: LEE, proposal: exchange("ORD-1022", 1), expect: { outcome: "DENY", code: "EXCHANGE_TARGET_REQUIRED" } },
  { id: "gate-exchange-same-variant", guards: "An 'exchange' for the identical item ships free goods", who: LEE, proposal: exchange("ORD-1022", 1, { newSize: "34", newColour: "Khaki" }), expect: { outcome: "DENY", code: "EXCHANGE_TARGET_REQUIRED" } },
  { id: "gate-exchange-unknown-variant", guards: "An exchange is created for a size that is not sold", who: LEE, proposal: exchange("ORD-1022", 1, { newSize: "48" }), expect: { outcome: "DENY", code: "VARIANT_NOT_OFFERED" } },

  // --- Human-approved mode --------------------------------------------------------------------
  { id: "gate-human-approved-may-override-window", guards: "An approver cannot grant a goodwill refund", who: C1, proposal: refund("ORD-1003", 1), mode: "human_approved", expect: { outcome: "ALLOW", amountCents: 11900 } },
  { id: "gate-human-approved-still-checks-ownership", guards: "Approval mode bypasses ownership", who: C1, proposal: refund("ORD-1005", 1), mode: "human_approved", expect: { outcome: "DENY", code: "ORDER_NOT_OWNED" } },
  { id: "gate-human-approved-cannot-exceed-quantity", guards: "Approval mode refunds more units than were bought", who: C2, proposal: refund("ORD-1007", 1, "changed_mind", { qty: 5 }), mode: "human_approved", expect: { outcome: "DENY", code: "QUANTITY_NOT_AVAILABLE" } },
];

function toCase(row: Row): EvalCase {
  return {
    id: row.id,
    guards: row.guards,
    async run() {
      const world = await makeWorld({ env: row.env });
      if (row.setup) await row.setup(world);
      const before = await dump(world.sql);
      const turn = await gateTurn(world, row.who, row.said ?? []);
      const ctx = await world.app.actions.buildContext(
        { orderId: row.proposal.orderId, type: row.proposal.type, lineId: row.proposal.type === "cancellation" ? undefined : row.proposal.lineId },
        turn,
        row.mode ?? "agent",
      );
      row.tweak?.(ctx);
      const d = evaluate(row.proposal, ctx);
      const after = await dump(world.sql);

      const c = new Checks();
      const e = row.expect;
      c.eq("outcome", d.outcome, e.outcome);
      if (e.code) c.has(`reason code ${e.code}`, d.codes, e.code);
      if (e.publicCode) c.eq("customer-safe code", d.publicCode, e.publicCode);
      if (e.amountCents !== undefined) c.eq("amount (cents), computed from the order", d.amountCents, e.amountCents);
      if (e.qty !== undefined) c.eq("quantity", d.qty, e.qty);
      if (e.priority) c.eq("priority", d.priority, e.priority);
      if (e.category) c.eq("review queue", d.escalationCategory, e.category);
      if (e.key !== undefined) c.eq("idempotency key", d.idempotencyKey, e.key);
      if (e.existingActionId) c.eq("points at the existing action", d.existingActionId, e.existingActionId);
      if (e.existingEscalationId) c.eq("points at the existing ticket", d.existingEscalationId, e.existingEscalationId);
      if (e.effectiveReason) c.eq("reason actually applied", d.effectiveReason, e.effectiveReason);
      if (e.alternatives) c.match("alternatives offered", d.alternatives.join(" | "), e.alternatives);
      if (e.riskTier) c.eq("risk tier", ctx.risk.tier, e.riskTier);
      for (const [k, v] of Object.entries(e.facts ?? {})) c.eq(`fact ${k}`, d.facts[k], v);
      // DENY and DUPLICATE carry no key at all. NEEDS_HUMAN keeps the key it would use (it is
      // logged for the reviewer) but cannot run: the executor only accepts outcome ALLOW.
      if (d.outcome === "DENY" || d.outcome === "DUPLICATE") c.eq("refused decisions carry no idempotency key", d.idempotencyKey, null);
      c.eq("evaluating moved no money", after.gatewayRefunds.length, before.gatewayRefunds.length);
      c.ok("customer-facing text hides internal codes", !/RISK|VELOCITY|BUDGET|AUTO_LIMIT|risk tier/i.test(d.say), d.say);
      c.add(await invariants(world.sql));
      return {
        criteria: c.list,
        evidence: { who: row.who, identity: turn.identity, mode: row.mode ?? "agent", customerSaid: row.said ?? [], proposal: row.proposal, decision: d, risk: ctx.risk, usage: ctx.usage, ledgerAfterSetup: before.actions },
      };
    },
  };
}

/** Someone else's order must be indistinguishable from an order that does not exist. */
const indistinguishable: EvalCase = {
  id: "gate-foreign-order-indistinguishable-from-missing",
  guards: "Order numbers can be probed: the reply differs for 'exists but not yours' and 'does not exist'",
  async run() {
    const world = await makeWorld();
    const turn = await gateTurn(world, C1);
    const decide = async (orderId: string) =>
      evaluate(refund(orderId, 1), await world.app.actions.buildContext({ orderId, type: "refund", lineId: `${orderId}-1` }, turn, "agent"));
    const foreign = await decide("ORD-1005");
    const missing = await decide("ORD-9999");
    await turn.audit.flush();
    const strip = (s: string) => s.replace(/ORD-\d+/g, "ORD-X");
    const c = new Checks();
    c.eq("same outcome", foreign.outcome, missing.outcome);
    c.eq("same customer-safe code", foreign.publicCode, missing.publicCode);
    c.eq("same customer-facing text", strip(foreign.say), strip(missing.say));
    c.eq("same hint to the model", foreign.hint, missing.hint);
    c.has("internally recorded as someone else's order", foreign.codes, "ORDER_NOT_OWNED");
    const db = await dump(world.sql);
    c.eq("the probe is recorded as a risk event, once", db.riskEvents.filter((r) => r.kind === "ownership_violation").length, 1);
    c.add(await invariants(world.sql));
    return { criteria: c.list, evidence: { foreign, missing, riskEvents: db.riskEvents } };
  },
};

export const gateCases: EvalCase[] = [...ROWS.map(toCase), indistinguishable];
