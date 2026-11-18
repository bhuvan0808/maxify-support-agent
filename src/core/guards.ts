/**
 * Input and output guardrails. Deterministic, cheap, and independent of the model.
 *
 * Input:  size limit, control-character stripping, redaction of card numbers and
 *         Singapore NRIC/FIN numbers before anything is stored or sent to the model,
 *         and detection (not blocking) of prompt-injection phrasing for the audit log.
 *         Injection is not blocked here because blocking on phrasing is easy to evade
 *         and annoys real customers; the Money Gate is what makes injection harmless.
 *
 * Output: the reply must agree with the ledger. It may not claim a refund, exchange or
 *         cancellation that did not happen, quote an amount that no tool returned,
 *         mention an order the customer does not own, or leak internal terms. A reply
 *         that fails is replaced with a safe one built from the turn's real outcomes.
 */

import type { TurnAction } from "./types.ts";

// --- Input -------------------------------------------------------------------------

export interface InputCheck {
  text: string;
  redactions: string[];
  injectionSignals: string[];
  truncated: boolean;
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

const INJECTION_PATTERNS: [string, RegExp][] = [
  ["ignore_instructions", /\b(ignore|disregard|forget|override)\b.{0,30}\b(previous|prior|above|earlier|all|your|system)\b.{0,20}\b(instructions?|rules?|prompts?|polic(y|ies)|guidelines?)\b/i],
  ["role_reassignment", /\b(you are now|act as|pretend (to be|you are)|from now on you|new persona|developer mode|jailbreak|DAN mode)\b/i],
  ["authority_claim", /\b(i am|i'm|this is)\b.{0,20}\b(the |an? )?(admin|administrator|developer|manager|supervisor|ceo|owner|staff|employee|system)\b/i],
  ["system_prompt_probe", /\b(system prompt|your (instructions|prompt|rules)|initial prompt|hidden instructions)\b/i],
  ["fake_system_message", /(\[|<|#{2,})\s*(system|assistant|admin|tool)\s*(\]|>|:)/i],
  ["tool_manipulation", /\b(call|invoke|run|execute|use)\b.{0,25}\b(tool|function|request_refund|request_cancellation|request_exchange)\b/i],
  ["policy_override", /\b(bypass|skip|waive|override)\b.{0,25}\b(polic(y|ies)|check|verification|approval|limit|review)\b/i],
];

export function checkInput(raw: string, maxChars: number): InputCheck {
  const redactions: string[] = [];
  // Strip control characters (keep newlines and tabs) and zero-width characters used to hide text.
  let text = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏⁠﻿]/g, "");
  let truncated = false;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }

  // Payment card numbers: 13 to 19 digits, optionally separated, that pass the Luhn check.
  text = text.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (match) => {
    const digits = match.replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      redactions.push("payment_card");
      return "[card number removed]";
    }
    return match;
  });
  // Singapore NRIC / FIN. PDPC guidance: do not collect these unless legally required.
  text = text.replace(/\b[STFGM]\d{7}[A-Z]\b/gi, () => {
    redactions.push("nric");
    return "[ID number removed]";
  });
  // Card security codes when labelled as such.
  text = text.replace(/\b(cvv|cvc|cvn|security code)\b\D{0,5}\d{3,4}\b/gi, (_m, label: string) => {
    redactions.push("card_security_code");
    return `${label} [removed]`;
  });

  const injectionSignals = INJECTION_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  return { text: text.trim(), redactions, injectionSignals, truncated };
}

// --- Output ------------------------------------------------------------------------

export interface OutputContext {
  /** Actions executed in this turn. */
  turnActions: TurnAction[];
  /** Earlier actions this turn matched (a recognised repeat). */
  duplicates: TurnAction[];
  /** Action types this customer already has on record from earlier turns. */
  priorActionTypes: Set<string>;
  /** Every string the model was shown this turn that may legitimately contain amounts and order IDs. */
  groundingText: string;
  /** Order IDs the customer owns or typed themselves. */
  allowedOrderIds: Set<string>;
  /** Email addresses that may appear in a reply (the customer's own, support). */
  allowedEmails: Set<string>;
}

export interface OutputCheck {
  ok: boolean;
  violations: string[];
}

/**
 * "Has happened" phrasing for each action type. Written to match affirmative past or
 * perfect forms only, so "has not been refunded" and "will be refunded" do not match.
 */
/**
 * Text allowed between the subject of a claim and its verb: anything within the same
 * sentence. A "." followed by a digit is a decimal point, not the end of a sentence,
 * so "refund of S$329.00 has been approved" is one claim. (Regression: excluding every
 * "." here let any false claim that quoted a cents amount past the guard. See
 * eval_runs/FIX_LOG.md.)
 */
const GAP = String.raw`(?:[^.!?\n]|\.(?=\d))`;

const CLAIM_PATTERNS: Record<"refund" | "cancellation" | "exchange", RegExp[]> = {
  refund: [
    /\b(i|we)(?:'ve| have)?(?: just)?\s+(?:now |already |successfully |gone ahead and )*(refunded|(?:issued|processed|initiated|sent|approved|completed) (?:a|the|your|that) (?:full |partial )?refund\b(?!\s+request))/i,
    new RegExp(
      String.raw`\brefund\b(?!\s+request)(?: of ${GAP}{0,25})?\s+(?:has been|was|is now|is being|has now been)\s+(?:successfully )?(issued|processed|approved|completed|initiated|sent|credited|confirmed|made)\b`,
      "i",
    ),
    /\b(?:has|have) (?:now |already )?been (?:fully |successfully )?refunded\b/i,
    /\brefund (?:is|will be) on its way\b/i,
    new RegExp(String.raw`\b(?:you'll|you will|you should) (?:see|receive|get) (?:your |the |a )?(?:refund|money)${GAP}{0,40}\b(?:within|in) \d`, "i"),
  ],
  cancellation: [
    /\b(i|we)(?:'ve| have)?(?: just)?\s+(?:now |already |successfully |gone ahead and )*cancell?ed\b/i,
    new RegExp(String.raw`\b(?:order|it)\b${GAP}{0,30}\b(?:has been|was|is now|has now been)\s+(?:successfully )?cancell?ed\b`, "i"),
    /\bcancellation (?:has been|is|was) (?:processed|confirmed|completed)\b/i,
  ],
  exchange: [
    /\b(i|we)(?:'ve| have)?(?: just)?\s+(?:now |already |successfully |gone ahead and )*(exchanged|(?:arranged|set up|processed|created|confirmed) (?:an|the|your|that) exchange\b(?!\s+request))/i,
    /\bexchange\b(?!\s+request)\s+(?:has been|was|is now|is)\s+(?:successfully )?(confirmed|processed|arranged|created|approved|completed|set up)\b/i,
    /\breplacement (?:has been|is being|was) (?:shipped|sent|dispatched)\b/i,
  ],
};

/**
 * "Once the team approves, your refund will be issued" is a condition, not a claim.
 * Only a condition that comes before the claim in the same sentence excuses it.
 */
const CONDITIONAL_PREFIX = /(if|once|when|after|as soon as|until)/i;

const INTERNAL_TERMS = /\b(risk (tier|score|profile|flag|review)|fraud (score|flag)|auto[- ]?(refund )?limit|velocity|kill switch|system prompt|CUSTOMER_RISK|AMOUNT_OVER|REFUND_VELOCITY|DAILY_BUDGET|serial refunder|idempotency)\b/i;

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?\n])\s+/).filter((s) => s.trim().length > 0);
}

/** Money amounts in cents found in a piece of text ("S$69.00", "$69", "SGD 1,020.50", "69.00 dollars"). */
export function extractAmounts(text: string): Set<number> {
  const found = new Set<number>();
  const pattern = /(?:S\$|SGD\s?|\$)\s?(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?|\b(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})\s?(?:dollars|SGD)\b/gi;
  for (const m of text.matchAll(pattern)) {
    const whole = (m[1] ?? m[3] ?? "0").replace(/,/g, "");
    const frac = (m[2] ?? m[4] ?? "0").padEnd(2, "0");
    found.add(Number(whole) * 100 + Number(frac));
  }
  return found;
}

export function checkOutput(reply: string, ctx: OutputContext): OutputCheck {
  const violations: string[] = [];
  if (reply.trim().length === 0) return { ok: false, violations: ["EMPTY_REPLY"] };

  // 1. Claims of completed actions must be backed by the ledger.
  const backed = new Set<string>(ctx.priorActionTypes);
  for (const a of [...ctx.turnActions, ...ctx.duplicates]) {
    if (a.type !== "escalation" && (a.status === "executed" || a.status === "pending")) backed.add(a.type);
    // A cancellation always carries a refund, so "your refund has been issued" is true after one.
    if (a.type === "cancellation" && a.status === "executed") backed.add("refund");
  }
  if (ctx.priorActionTypes.has("cancellation")) backed.add("refund");
  for (const [type, patterns] of Object.entries(CLAIM_PATTERNS)) {
    if (backed.has(type)) continue;
    for (const sentence of sentences(reply)) {
      if (sentence.trim().endsWith("?")) continue;
      const claim = patterns
        .map((p) => p.exec(sentence))
        .find((m) => m !== null && !CONDITIONAL_PREFIX.test(sentence.slice(0, m.index)));
      if (claim) {
        violations.push(`UNBACKED_CLAIM:${type}`);
        break;
      }
    }
  }

  // 2. Every amount quoted must have come from a tool result or the policy text.
  const known = extractAmounts(ctx.groundingText);
  // A total across several actions taken this turn is legitimate even if no tool printed it.
  const turnAmounts = [...ctx.turnActions, ...ctx.duplicates].map((a) => a.amountCents ?? 0).filter((n) => n > 0).slice(0, 8);
  for (let mask = 1; mask < 1 << turnAmounts.length; mask++) {
    let sum = 0;
    for (let i = 0; i < turnAmounts.length; i++) if (mask & (1 << i)) sum += turnAmounts[i]!;
    known.add(sum);
  }
  for (const amount of extractAmounts(reply)) {
    if (!known.has(amount)) {
      violations.push(`UNGROUNDED_AMOUNT:${(amount / 100).toFixed(2)}`);
    }
  }

  // 3. No order numbers other than the customer's own or ones they typed.
  for (const m of reply.matchAll(/\bORD-\d{3,}\b/gi)) {
    if (!ctx.allowedOrderIds.has(m[0].toUpperCase())) violations.push(`FOREIGN_ORDER_ID:${m[0].toUpperCase()}`);
  }

  // 4. No email addresses other than the customer's own and the support address.
  for (const m of reply.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) {
    if (!ctx.allowedEmails.has(m[0].toLowerCase())) violations.push("FOREIGN_EMAIL");
  }

  // 5. No internal risk or limit vocabulary.
  if (INTERNAL_TERMS.test(reply)) violations.push("INTERNAL_TERM_LEAK");

  return { ok: violations.length === 0, violations: [...new Set(violations)] };
}
