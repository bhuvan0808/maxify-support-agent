/**
 * The Money Gate.
 *
 * This is the only place that decides whether a refund, exchange or cancellation may
 * happen. It is plain deterministic code: no model call, no I/O, no clock of its own.
 * Given the same proposal and context it always returns the same decision, which is
 * what makes it unit-testable case by case (see evals/suites/gate.ts).
 *
 * The model can only *propose*. Whatever it proposes, and however it was persuaded to
 * propose it, the outcome is one of:
 *
 *   ALLOW        every rule passed; the executor may act
 *   DENY         a rule forbids it; the customer is told why and what they can do instead
 *   NEEDS_HUMAN  allowed in principle but not without a person (unverified fault claim,
 *                amount over the limit, risk review, budget, statutory claim, kill switch)
 *   DUPLICATE    this has already been done or is already under review
 *
 * Order of checks: identity and ownership, order state, quantity and repeats, policy
 * (window, sale, hygiene), then risk and limits. Amounts are computed here from order
 * data; nothing the model says about money is ever used.
 */

import type { Priority, TenantConfig } from "../config/tenant.ts";
import type { RiskProfile } from "./risk.ts";
import type {
  ActionRecord,
  CancellationProposal,
  Decision,
  EscalationCategory,
  EscalationRecord,
  ExchangeProposal,
  Identity,
  Order,
  OrderLine,
  ProductVariant,
  Proposal,
  RefundProposal,
  ReturnReason,
} from "./types.ts";
import { FAULT_REASONS } from "./types.ts";
import {
  addDays,
  addMonths,
  calendarDaysBetween,
  compareLocalDates,
  formatDay,
  formatLocalDate,
  formatMoney,
  localDate,
  normaliseText,
} from "./util.ts";

export interface GateContext {
  now: Date;
  cfg: TenantConfig;
  identity: Identity;
  /** The order, only if it exists AND belongs to this identity. Otherwise null. */
  order: Order | null;
  /** True when the order ID exists but belongs to someone else. Never revealed to the customer. */
  foreignOrder: boolean;
  /** Units already refunded or exchanged, per line. */
  lines: Map<string, { refundedQty: number; exchangedQty: number }>;
  /** Money already refunded on this order. */
  orderRefundedCents: number;
  /** Every action on this order, any status. */
  actions: ActionRecord[];
  /** Every review ticket on this order, any status. */
  escalations: EscalationRecord[];
  risk: RiskProfile;
  usage: {
    /** Refunds the agent has auto-executed today, all customers. */
    autoRefundedTodayCents: number;
    /** Refunds auto-executed for this customer in the last 30 days. */
    customerAutoRefunds30d: number;
  };
  /** What the customer actually typed in this conversation, for grounding fault claims. */
  customerMessages: string[];
  /** Variants of the line's product, for exchanges. */
  variants: ProductVariant[] | null;
  /** Kill switch. When false nothing is executed automatically. */
  moneyActionsEnabled: boolean;
  /**
   * agent           a live proposal from the model: every rule applies
   * preview         a dry run used to tell the customer their options: skips checks that
   *                 need details the customer has not given yet
   * human_approved  an approver has taken responsibility for policy and risk; only the
   *                 hard invariants (ownership, order state, quantities, amounts) apply
   */
  mode: "agent" | "preview" | "human_approved";
}

// --- Helpers used by the gate and by tests ----------------------------------------

export function ownsOrder(identity: Identity, order: Order): boolean {
  if (identity.kind === "unrecognised") return false;
  if (identity.customerId && order.customerId === identity.customerId) return true;
  if (identity.email && order.guestEmail && order.guestEmail.toLowerCase() === identity.email.toLowerCase()) {
    return true;
  }
  return false;
}

/**
 * True when `quote` is something the customer actually typed. This stops the model
 * from inventing a fault on the customer's behalf to unlock a refund.
 * Exact (normalised) containment passes; so does a close paraphrase, because models
 * sometimes tidy punctuation or drop a word when quoting.
 */
export function isGrounded(quote: string | undefined, customerMessages: string[]): boolean {
  if (!quote) return false;
  const needle = normaliseText(quote);
  if (needle.length < 6) return false;
  const haystack = normaliseText(customerMessages.join(" "));
  if (haystack.includes(needle)) return true;
  const words = needle.split(" ").filter((w) => w.length >= 3);
  if (words.length < 2) return false;
  const typed = new Set(haystack.split(" "));
  const matched = words.filter((w) => typed.has(w)).length;
  return matched / words.length >= 0.7;
}

const FAULT_WORDS =
  /\b(defect\w*|fault\w*|broke\w*|damag\w*|torn|tear\w*|rip(ped|s)?|hole\w*|stain\w*|zip\w*|seam\w*|stitch\w*|thread\w*|button\w*|unravel\w*|fray\w*|peel\w*|fad(ed|ing)|discolou?r\w*|crack\w*|snapp\w*|split\w*|mould\w*|mold\w*|leak\w*|misprint\w*|came apart|fell apart|fall(ing)? apart|coming apart|wrong (item|size|colou?r|product)|not as described|not what i ordered|different (item|colou?r|size|product))\b/i;

/** True when the customer's own words describe a physical fault or a wrong item. */
export function mentionsFault(customerMessages: string[]): boolean {
  return FAULT_WORDS.test(customerMessages.join(" "));
}

const PRIORITY_RANK: Record<Priority, number> = { P1: 0, P2: 1, P3: 2 };

interface Review {
  code: string;
  category: EscalationCategory;
  priority: Priority;
}

function blank(proposal: Proposal): Decision {
  return {
    outcome: "DENY",
    codes: [],
    publicCode: "",
    say: "",
    alternatives: [],
    hint: null,
    amountCents: 0,
    qty: 0,
    lineId: proposal.type === "cancellation" ? null : proposal.lineId,
    idempotencyKey: null,
    priority: null,
    escalationCategory: null,
    existingActionId: null,
    existingEscalationId: null,
    effectiveReason: proposal.type === "cancellation" ? null : proposal.reason,
    facts: {},
  };
}

interface DenyExtras {
  publicCode?: string;
  alternatives?: string[];
  hint?: string;
  existingActionId?: string;
}

function deny(d: Decision, code: string, say: string, extras: DenyExtras = {}): Decision {
  return {
    ...d,
    outcome: "DENY",
    codes: [...d.codes, code],
    publicCode: extras.publicCode ?? code,
    say,
    alternatives: extras.alternatives ?? [],
    hint: extras.hint ?? null,
    existingActionId: extras.existingActionId ?? null,
    idempotencyKey: null,
  };
}

function duplicate(
  d: Decision,
  code: string,
  say: string,
  existing: { actionId?: string | null; escalationId?: string | null },
): Decision {
  return {
    ...d,
    outcome: "DUPLICATE",
    codes: [...d.codes, code],
    publicCode: code,
    say,
    existingActionId: existing.actionId ?? null,
    existingEscalationId: existing.escalationId ?? null,
    idempotencyKey: null,
  };
}

function needsHuman(d: Decision, reviews: Review[], say: string): Decision {
  const top = [...reviews].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority])[0]!;
  const faultRelated = reviews.some((r) => r.category === "defect_verification" || r.category === "statutory_defect_claim");
  return {
    ...d,
    outcome: "NEEDS_HUMAN",
    codes: [...d.codes, ...reviews.map((r) => r.code)],
    publicCode: faultRelated ? "FAULT_CHECK_REQUIRED" : "REVIEW_REQUIRED",
    say,
    priority: top.priority,
    // The first review is the most specific reason; it names the queue the ticket goes to.
    escalationCategory: reviews[0]!.category,
  };
}

function allow(d: Decision, say: string): Decision {
  return { ...d, outcome: "ALLOW", codes: [...d.codes, "ALL_CHECKS_PASSED"], publicCode: "APPROVED", say };
}

function variantList(variants: ProductVariant[], exclude: { size: string; colour: string }): string {
  const inStock = variants.filter((v) => v.stock > 0 && !(v.size === exclude.size && v.colour === exclude.colour));
  if (inStock.length === 0) return "nothing else is in stock at the moment";
  return inStock.map((v) => `${v.size} ${v.colour}`).join(", ");
}

// --- Entry point ------------------------------------------------------------------

export function evaluate(proposal: Proposal, ctx: GateContext): Decision {
  const d = blank(proposal);
  d.facts = { mode: ctx.mode, policyVersion: ctx.cfg.policy.version, riskTier: ctx.risk.tier };

  if (ctx.identity.kind === "unrecognised") {
    return deny(d, "IDENTITY_NOT_RECOGNISED", "I can't find an account or any orders for these details, so I can't act on an order.", {
      hint: "Ask the customer to check the customer ID or the email address used at checkout.",
    });
  }
  if (!ctx.order) {
    // Same customer-facing answer whether the order does not exist or belongs to someone
    // else, so order numbers cannot be probed.
    return deny(
      d,
      ctx.foreignOrder ? "ORDER_NOT_OWNED" : "ORDER_NOT_FOUND",
      `I couldn't find order ${proposal.orderId} under this customer's details.`,
      { publicCode: "ORDER_NOT_FOUND", hint: "Ask the customer to check the order number. Do not act on it." },
    );
  }

  switch (proposal.type) {
    case "refund":
      return evaluateRefund(proposal, ctx, ctx.order, d);
    case "exchange":
      return evaluateExchange(proposal, ctx, ctx.order, d);
    case "cancellation":
      return evaluateCancellation(proposal, ctx, ctx.order, d);
  }
}

// --- Shared checks for returns (refund and exchange) --------------------------------

interface ReturnBasics {
  line: OrderLine;
  actioned: number;
  remaining: number;
  qty: number;
  live: ActionRecord[];
  days: number;
  inWindow: boolean;
  inStatutory: boolean;
  deliveredOn: string;
  windowClosesOn: string;
}

/** Order-state, quantity and repeat checks common to refunds and exchanges. Returns a Decision to stop, or the basics to continue. */
function returnBasics(
  p: RefundProposal | ExchangeProposal,
  ctx: GateContext,
  order: Order,
  d: Decision,
): Decision | ReturnBasics {
  const tz = ctx.cfg.locale.timeZone;
  const sym = ctx.cfg.locale.currencySymbol;
  const verb = p.type === "refund" ? "refund" : "exchange";

  const line = order.lines.find((l) => l.id === p.lineId);
  if (!line) {
    return deny(d, "LINE_NOT_FOUND", `That item isn't part of order ${order.id}.`, {
      hint: `Valid line_id values for ${order.id}: ${order.lines.map((l) => `${l.id} (${l.name})`).join(", ")}.`,
    });
  }

  if (order.status === "cancelled") {
    return deny(d, "ORDER_CANCELLED", `Order ${order.id} was cancelled, so there is nothing to return.`);
  }
  if (order.status === "processing") {
    return deny(d, "NOT_SHIPPED_YET", `Order ${order.id} hasn't shipped yet, so it can be cancelled rather than returned.`, {
      alternatives: ["Cancel the order for a full refund (request_cancellation)."],
    });
  }
  if (order.status === "shipped" || !order.deliveredAt) {
    return deny(
      d,
      "NOT_YET_DELIVERED",
      `Order ${order.id} is on its way and hasn't been delivered yet. A return or exchange can be arranged once it arrives.`,
      { alternatives: ["If the parcel seems lost or badly delayed, hand over to a human (delivery_problem)."] },
    );
  }

  const ledger = ctx.lines.get(line.id) ?? { refundedQty: 0, exchangedQty: 0 };
  const actioned = ledger.refundedQty + ledger.exchangedQty;
  const remaining = line.qty - actioned;
  const live = ctx.actions.filter((a) => a.lineId === line.id && a.status !== "failed" && a.type !== "cancellation");

  if (ctx.mode !== "human_approved") {
    const open = ctx.escalations.find(
      (e) => e.status === "open" && e.lineId === line.id && e.proposedAction?.type === p.type,
    );
    if (open) {
      return duplicate(
        d,
        "ALREADY_UNDER_REVIEW",
        `A ${verb} request for this item is already with our team (reference ${open.id}). There is no need to ask again; they will be in touch.`,
        { escalationId: open.id },
      );
    }
  }

  if (remaining <= 0) {
    const sameType = live.filter((a) => a.type === p.type).at(-1);
    if (sameType) {
      const when = formatDay(sameType.createdAt, tz);
      const money = p.type === "refund" ? `, ${formatMoney(sameType.amountCents, sym)}` : "";
      return duplicate(
        d,
        p.type === "refund" ? "ALREADY_REFUNDED" : "ALREADY_EXCHANGED",
        `This item already has a ${verb} on record from ${when} (reference ${sameType.id}${money}). Nothing further is due.`,
        { actionId: sameType.id },
      );
    }
    const other = live.at(-1);
    return deny(
      d,
      p.type === "refund" ? "ALREADY_EXCHANGED" : "ALREADY_REFUNDED",
      `This item has already been ${p.type === "refund" ? "exchanged" : "refunded"}${other ? ` (reference ${other.id})` : ""}, so it can't also be ${p.type === "refund" ? "refunded" : "exchanged"}.`,
      { existingActionId: other?.id },
    );
  }

  const qty = p.qty ?? remaining;
  if (!Number.isInteger(qty) || qty < 1 || qty > remaining) {
    return deny(d, "QUANTITY_NOT_AVAILABLE", `Only ${remaining} of this item can still be returned.`);
  }

  // A second action on a line that already has one must name the first. A plain repeat
  // of the same request therefore can never silently pay out again.
  if (ctx.mode === "agent" && live.length > 0 && !live.some((a) => a.id === p.additionalToActionId)) {
    const prior = live.at(-1)!;
    return deny(
      d,
      "CONFIRM_ADDITIONAL_UNITS",
      `${actioned} of the ${line.qty} units of this item already has a ${prior.type} on record (reference ${prior.id}).`,
      {
        existingActionId: prior.id,
        hint: `If the customer is just repeating their earlier request, tell them it was already done. Only if they clearly want to return a further unit, call again with additional_to_action_id="${prior.id}".`,
      },
    );
  }

  if (ctx.mode === "agent") {
    const declined = ctx.escalations.find(
      (e) => e.status === "rejected" && e.lineId === line.id && e.proposedAction?.type === p.type,
    );
    if (declined) {
      return deny(
        d,
        "PREVIOUSLY_DECLINED",
        `Our team reviewed a ${verb} for this item${declined.decidedAt ? ` on ${formatDay(declined.decidedAt, tz)}` : ""} and wasn't able to approve it (reference ${declined.id}).`,
        { alternatives: ["If the customer has new information or disagrees, hand over to a human (complaint)."] },
      );
    }
  }

  const deliveredDate = localDate(order.deliveredAt, tz);
  const today = localDate(ctx.now, tz);
  const days = calendarDaysBetween(order.deliveredAt, ctx.now, tz);
  const windowCloses = addDays(deliveredDate, ctx.cfg.policy.returnWindowDays);
  const statutoryCloses = addMonths(deliveredDate, ctx.cfg.policy.statutoryDefectWindowMonths);

  return {
    line,
    actioned,
    remaining,
    qty,
    live,
    days,
    inWindow: days <= ctx.cfg.policy.returnWindowDays,
    inStatutory: compareLocalDates(today, statutoryCloses) <= 0,
    deliveredOn: formatLocalDate(deliveredDate),
    windowClosesOn: formatLocalDate(windowCloses),
  };
}

function isDecision(value: Decision | ReturnBasics): value is Decision {
  return "outcome" in value;
}

/** Applies a fault claim only if it is grounded in the customer's words. */
function resolveFault(
  p: RefundProposal | ExchangeProposal,
  ctx: GateContext,
  faultChangesOutcome: boolean,
  d: Decision,
): { stop: Decision } | { reason: ReturnReason; fault: boolean; codes: string[] } {
  const claimed = FAULT_REASONS.has(p.reason);
  if (!claimed) return { reason: p.reason, fault: false, codes: [] };
  const grounded = ctx.mode !== "agent" || isGrounded(p.evidenceQuote, ctx.customerMessages);
  if (grounded) return { reason: p.reason, fault: true, codes: [] };
  if (faultChangesOutcome) {
    return {
      stop: deny(d, "FAULT_DETAILS_REQUIRED", "To look into a fault we need the customer's own description of what is wrong with the item.", {
        hint: "Ask the customer what exactly is wrong with the item. Then call again with customer_quote set to their exact words. Never describe a fault the customer has not described.",
      }),
    };
  }
  // The claim would not change the outcome, so proceed without it rather than block the
  // customer, and do not count it as a defect claim in their history.
  return { reason: "other", fault: false, codes: ["FAULT_REASON_NOT_GROUNDED"] };
}

const SAY_FAULT_REVIEW =
  "Fault claims are checked by our team before a refund or replacement is confirmed. They may ask for a photo of the problem.";
const SAY_GENERAL_REVIEW = "This request needs a review by our team before it can go ahead.";

// --- Refund ------------------------------------------------------------------------

function evaluateRefund(p: RefundProposal, ctx: GateContext, order: Order, d: Decision): Decision {
  const cfg = ctx.cfg;
  const sym = cfg.locale.currencySymbol;
  const basics = returnBasics(p, ctx, order, d);
  if (isDecision(basics)) return basics;
  const { line, actioned, qty, days, inWindow, inStatutory, deliveredOn, windowClosesOn } = basics;

  // The amount is what was paid for these units, capped by what is left on the order.
  const amount = Math.min(line.unitPaidCents * qty, order.totalPaidCents - ctx.orderRefundedCents);
  d = {
    ...d,
    lineId: line.id,
    qty,
    amountCents: amount,
    idempotencyKey: `refund:${line.id}:u${actioned}`,
    facts: {
      ...d.facts,
      daysSinceDelivery: days,
      deliveredOn,
      windowClosesOn,
      inWindow,
      inStatutoryWindow: inStatutory,
      purchasedOnSale: line.purchasedOnSale,
      hygiene: line.hygiene,
      unitPaidCents: line.unitPaidCents,
    },
  };
  if (amount <= 0) {
    return deny(d, "NOTHING_TO_REFUND", `Order ${order.id} has already been refunded in full.`);
  }
  const amountText = formatMoney(amount, sym);
  const approvedSay = `Refund of ${amountText} to the original payment method (${order.paymentMethod}). It usually shows within ${cfg.policy.refundSettlementDays}. A prepaid return label has been emailed; the item should be sent back within 14 days.`;

  if (ctx.mode === "human_approved") return allow(d, approvedSay);

  const faultChangesOutcome = !inWindow || line.hygiene || line.purchasedOnSale;
  const resolved = resolveFault(p, ctx, faultChangesOutcome, d);
  if ("stop" in resolved) return resolved.stop;
  d = { ...d, effectiveReason: resolved.reason, codes: [...d.codes, ...resolved.codes] };
  const fault = resolved.fault;

  const reviews: Review[] = [];

  // --- Policy ---
  if (!inWindow) {
    if (fault && inStatutory) {
      // Singapore Lemon Law: a fault reported within 6 months of delivery is presumed to have
      // existed at delivery. Store policy cannot exclude that right, so never auto-deny it.
      reviews.push({ code: "STATUTORY_DEFECT_CLAIM", category: "statutory_defect_claim", priority: "P2" });
    } else {
      return deny(
        d,
        "RETURN_WINDOW_EXPIRED",
        `This item was delivered on ${deliveredOn} and our ${cfg.policy.returnWindowDays}-day return window closed on ${windowClosesOn}, so it can no longer be returned for a refund.`,
        { alternatives: inStatutory ? ["If the item is faulty, describe the fault and our team will look into it."] : [] },
      );
    }
  } else if (line.hygiene) {
    if (fault) {
      reviews.push({ code: "DEFECT_VERIFICATION_REQUIRED", category: "defect_verification", priority: "P2" });
    } else {
      return deny(
        d,
        "HYGIENE_ITEM_NOT_RETURNABLE",
        `${line.name} is a hygiene item, so for health reasons it can't be returned or exchanged unless it is faulty.`,
        { alternatives: ["If the item is faulty, describe the fault and our team will look into it."] },
      );
    }
  } else if (line.purchasedOnSale) {
    if (!fault) {
      return deny(
        d,
        "SALE_ITEM_EXCHANGE_ONLY",
        `${line.name} was bought on sale. Sale items can be exchanged for another size or colour, but can't be refunded unless the item is faulty.`,
        {
          alternatives: [
            "Exchange it for another size or colour (request_exchange).",
            "If the item is faulty, describe the fault.",
          ],
        },
      );
    }
    const fastTrack =
      cfg.limits.defectFastTrackLimitCents > 0 &&
      amount <= cfg.limits.defectFastTrackLimitCents &&
      ctx.risk.tier === "low" &&
      ctx.risk.stats.defectRefunds180d === 0 &&
      (ctx.mode === "preview" || mentionsFault(ctx.customerMessages));
    if (fastTrack) d = { ...d, codes: [...d.codes, "DEFECT_FAST_TRACK"] };
    else reviews.push({ code: "DEFECT_VERIFICATION_REQUIRED", category: "defect_verification", priority: "P2" });
  }

  // --- Risk and limits ---
  if (!ctx.moneyActionsEnabled) {
    reviews.push({ code: "AUTOMATION_PAUSED", category: "automation_paused", priority: "P2" });
  }
  if (ctx.risk.tier === "high") {
    reviews.push({ code: "CUSTOMER_RISK_REVIEW", category: "risk_review", priority: "P2" });
  }
  const limit = Math.floor(
    cfg.limits.autoRefundLimitCents * (ctx.risk.tier === "elevated" ? cfg.risk.elevatedLimitFactor : 1),
  );
  d.facts = { ...d.facts, autoLimitCents: limit };
  if (amount > limit) {
    reviews.push({
      code: "AMOUNT_OVER_AUTO_LIMIT",
      category: "refund_review",
      priority: amount >= cfg.limits.highValueReviewCents ? "P1" : "P2",
    });
  }
  if (ctx.usage.customerAutoRefunds30d >= cfg.limits.maxAutoRefundsPer30Days) {
    reviews.push({ code: "REFUND_VELOCITY", category: "risk_review", priority: "P2" });
  }
  if (ctx.usage.autoRefundedTodayCents + amount > cfg.limits.dailyAutoRefundBudgetCents) {
    reviews.push({ code: "DAILY_BUDGET_EXCEEDED", category: "budget_exceeded", priority: "P1" });
  }

  if (reviews.length > 0) return needsHuman(d, reviews, fault ? SAY_FAULT_REVIEW : SAY_GENERAL_REVIEW);
  return allow(d, approvedSay);
}

// --- Exchange ----------------------------------------------------------------------

function evaluateExchange(p: ExchangeProposal, ctx: GateContext, order: Order, d: Decision): Decision {
  const cfg = ctx.cfg;
  const basics = returnBasics(p, ctx, order, d);
  if (isDecision(basics)) return basics;
  const { line, actioned, qty, days, inWindow, inStatutory, deliveredOn, windowClosesOn } = basics;

  d = {
    ...d,
    lineId: line.id,
    qty,
    amountCents: 0,
    idempotencyKey: `exchange:${line.id}:u${actioned}`,
    facts: {
      ...d.facts,
      daysSinceDelivery: days,
      deliveredOn,
      windowClosesOn,
      inWindow,
      inStatutoryWindow: inStatutory,
      purchasedOnSale: line.purchasedOnSale,
      hygiene: line.hygiene,
    },
  };

  const reviews: Review[] = [];
  let fault = false;

  if (ctx.mode !== "human_approved") {
    const faultChangesOutcome = !inWindow || line.hygiene;
    const resolved = resolveFault(p, ctx, faultChangesOutcome, d);
    if ("stop" in resolved) return resolved.stop;
    d = { ...d, effectiveReason: resolved.reason, codes: [...d.codes, ...resolved.codes] };
    fault = resolved.fault;

    if (!inWindow) {
      if (fault && inStatutory) {
        reviews.push({ code: "STATUTORY_DEFECT_CLAIM", category: "statutory_defect_claim", priority: "P2" });
      } else {
        return deny(
          d,
          "RETURN_WINDOW_EXPIRED",
          `This item was delivered on ${deliveredOn} and our ${cfg.policy.returnWindowDays}-day return and exchange window closed on ${windowClosesOn}.`,
          { alternatives: inStatutory ? ["If the item is faulty, describe the fault and our team will look into it."] : [] },
        );
      }
    } else if (line.hygiene) {
      if (fault) {
        reviews.push({ code: "DEFECT_VERIFICATION_REQUIRED", category: "defect_verification", priority: "P2" });
      } else {
        return deny(
          d,
          "HYGIENE_ITEM_NOT_RETURNABLE",
          `${line.name} is a hygiene item, so for health reasons it can't be returned or exchanged unless it is faulty.`,
          { alternatives: ["If the item is faulty, describe the fault and our team will look into it."] },
        );
      }
    }
  }

  // --- Replacement variant. A preview only reports eligibility, so it skips this. ---
  if (ctx.mode !== "preview") {
    const variants = ctx.variants ?? [];
    const current = { size: line.size, colour: line.colour };
    const wantSize = (p.newSize ?? line.size).trim().toLowerCase();
    const wantColour = (p.newColour ?? line.colour).trim().toLowerCase();
    const sameAsCurrent = wantSize === line.size.toLowerCase() && wantColour === line.colour.toLowerCase();
    if ((!p.newSize && !p.newColour) || sameAsCurrent) {
      return deny(d, "EXCHANGE_TARGET_REQUIRED", `Which size or colour would they like instead? In stock: ${variantList(variants, current)}.`, {
        hint: "Ask the customer which size or colour they want, then call again with new_size and/or new_colour.",
      });
    }
    const target = variants.find((v) => v.size.toLowerCase() === wantSize && v.colour.toLowerCase() === wantColour);
    if (!target) {
      return deny(
        d,
        "VARIANT_NOT_OFFERED",
        `${line.name} doesn't come in ${p.newSize ?? line.size} ${p.newColour ?? line.colour}. In stock: ${variantList(variants, current)}.`,
      );
    }
    if (target.stock < qty) {
      const alternatives = [`Other options in stock: ${variantList(variants, current)}.`];
      if (!line.purchasedOnSale && inWindow) alternatives.push("A refund instead (request_refund).");
      return deny(d, "VARIANT_OUT_OF_STOCK", `${line.name} in ${target.size} ${target.colour} is out of stock right now.`, {
        alternatives,
      });
    }
    d.facts = { ...d.facts, newSize: target.size, newColour: target.colour };
  }

  const approvedSay = `Exchange confirmed for ${line.name}${
    d.facts.newSize ? ` in ${String(d.facts.newSize)} ${String(d.facts.newColour)}` : ""
  }. The replacement ships once the original is posted back with the prepaid label we have emailed.`;
  if (ctx.mode === "human_approved") return allow(d, approvedSay);

  if (!ctx.moneyActionsEnabled) {
    reviews.push({ code: "AUTOMATION_PAUSED", category: "automation_paused", priority: "P2" });
  }
  if (ctx.risk.tier === "high") {
    reviews.push({ code: "CUSTOMER_RISK_REVIEW", category: "risk_review", priority: "P2" });
  }
  if (reviews.length > 0) return needsHuman(d, reviews, fault ? SAY_FAULT_REVIEW : SAY_GENERAL_REVIEW);
  return allow(d, approvedSay);
}

// --- Cancellation ------------------------------------------------------------------

function evaluateCancellation(p: CancellationProposal, ctx: GateContext, order: Order, d: Decision): Decision {
  const cfg = ctx.cfg;
  const sym = cfg.locale.currencySymbol;
  const tz = cfg.locale.timeZone;
  const refundable = order.totalPaidCents - ctx.orderRefundedCents;
  d = { ...d, amountCents: refundable, qty: 0, facts: { ...d.facts, orderStatus: order.status } };

  const done = ctx.actions.find((a) => a.type === "cancellation" && a.status === "executed");
  const open = ctx.escalations.find((e) => e.status === "open" && e.proposedAction?.type === "cancellation");
  const approvedSay = `Order ${order.id} is cancelled and ${formatMoney(refundable, sym)} is being refunded to the original payment method (${order.paymentMethod}). It usually shows within ${cfg.policy.refundSettlementDays}.`;

  if (order.status === "cancelled") {
    // An approver may complete a cancellation whose refund failed at the gateway.
    if (ctx.mode === "human_approved" && !done && refundable > 0) {
      return allow({ ...d, idempotencyKey: `cancellation:${order.id}` }, approvedSay);
    }
    return duplicate(
      d,
      "ALREADY_CANCELLED",
      done
        ? `Order ${order.id} was already cancelled on ${formatDay(done.createdAt, tz)} (reference ${done.id}) and ${formatMoney(done.amountCents, sym)} was refunded to ${order.paymentMethod}. Nothing further is needed.`
        : `Order ${order.id} is already cancelled.`,
      { actionId: done?.id ?? null },
    );
  }
  if (open && ctx.mode !== "human_approved") {
    return duplicate(
      d,
      "ALREADY_UNDER_REVIEW",
      `A cancellation request for order ${order.id} is already with our team (reference ${open.id}).`,
      { escalationId: open.id },
    );
  }
  if (order.status === "shipped") {
    return deny(
      d,
      "ALREADY_SHIPPED",
      `Order ${order.id} has already shipped, so it can't be cancelled. Once it arrives, a return or exchange can be arranged under the returns policy.`,
    );
  }
  if (order.status === "delivered") {
    return deny(d, "ALREADY_DELIVERED", `Order ${order.id} has already been delivered, so it can't be cancelled.`, {
      alternatives: ["A return or exchange, if the item is eligible (request_refund / request_exchange)."],
    });
  }

  d = { ...d, idempotencyKey: `cancellation:${order.id}` };
  if (ctx.mode === "human_approved") return allow(d, approvedSay);
  if (!ctx.moneyActionsEnabled) {
    return needsHuman(d, [{ code: "AUTOMATION_PAUSED", category: "automation_paused", priority: "P2" }], SAY_GENERAL_REVIEW);
  }
  return allow(d, approvedSay);
}
