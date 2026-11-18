/**
 * Tenant configuration: the single place a client changes to make the agent theirs.
 *
 * Everything a business would want to tune without touching agent logic lives here:
 * branding and theme, locale, policy parameters, money limits, risk thresholds,
 * escalation priorities and approver budgets.
 *
 * Every policy number the customer can be told (return window, shipping fee, ...)
 * is rendered into the system prompt from this object, so the prompt and the
 * Money Gate can never disagree.
 */

export type Priority = "P1" | "P2" | "P3";

export interface TenantConfig {
  brand: {
    /** Storefront name shown to customers. */
    name: string;
    /** Name the assistant introduces itself with. Always disclosed as an AI. */
    assistantName: string;
    supportEmail: string;
    /** CSS custom properties for the chat widget and ops console (light theme). */
    theme: Record<string, string>;
    /** Dark-theme overrides for the same properties. */
    themeDark: Record<string, string>;
  };
  locale: {
    country: string;
    currency: string;
    currencySymbol: string;
    /** IANA time zone used for all "calendar day" policy maths. */
    timeZone: string;
    /** Displayed prices are tax-inclusive; this is informational for the prompt. */
    taxLabel: string;
  };
  policy: {
    /** Recorded on every gate decision and action so a decision can be tied to the rules in force. */
    version: string;
    /** Policy (a): returns accepted up to this many calendar days after delivery. */
    returnWindowDays: number;
    /** Statutory window for defect claims (Singapore Lemon Law: 6 months). Claims in this window are never auto-denied. */
    statutoryDefectWindowMonths: number;
    refundSettlementDays: string;
    standardShippingCents: number;
    freeShippingThresholdCents: number;
    deliveryEstimate: string;
  };
  limits: {
    /** Largest single refund the agent may execute without a human. */
    autoRefundLimitCents: number;
    /** At or above this amount a review ticket is raised as P1. */
    highValueReviewCents: number;
    /**
     * Defective sale items at or under this amount can be refunded without human
     * verification, for low-risk customers with no recent defect claims. 0 disables the fast track.
     */
    defectFastTrackLimitCents: number;
    /** Total the agent may auto-refund per calendar day across all customers. */
    dailyAutoRefundBudgetCents: number;
    /** Auto-refunds allowed per customer in a rolling 30 days before a human must review. */
    maxAutoRefundsPer30Days: number;
  };
  risk: {
    /** Minimum delivered orders before the refund rate is considered meaningful. */
    minOrdersForElevated: number;
    elevatedRefundRate: number;
    minOrdersForHigh: number;
    highRefundRate: number;
    elevatedDefectClaims180d: number;
    highDefectClaims180d: number;
    /** Attempts to act on someone else's order within 30 days that make a customer high risk. */
    highOwnershipViolations30d: number;
    /** Elevated-risk customers get this fraction of the auto-refund limit. */
    elevatedLimitFactor: number;
  };
  escalation: {
    /** Minutes a human has to respond, by priority. */
    slaMinutes: Record<Priority, number>;
    /** Largest refund each approver role may approve. */
    approverLimitsCents: Record<string, number>;
    /** Demo approvers. In production this comes from the client's SSO / helpdesk roles. */
    approvers: Record<string, string>;
  };
  agent: {
    /** Hard cap on model round-trips per customer message. */
    maxSteps: number;
    /** Hard cap on tool calls per customer message. */
    maxToolCalls: number;
    /** Past messages replayed to the model for context. */
    historyMessages: number;
    maxMessageChars: number;
    maxReplyTokens: number;
    /** Messages allowed per identity per minute. */
    rateLimitPerMinute: number;
  };
}

/**
 * Default tenant: a fictional Singapore apparel retailer.
 * The theme uses the gomaxify.ai palette (evergreen, signal green, soft pastels).
 */
export const defaultTenant: TenantConfig = {
  brand: {
    name: "Tembusu & Co.",
    assistantName: "Tembusu Assistant",
    supportEmail: "care@tembusu.example",
    theme: {
      "--bg": "#FAFAF7",
      "--card": "#FFFFFF",
      "--ink": "#13221B",
      "--muted": "#5A6472",
      "--line": "rgba(19,34,27,0.13)",
      "--line-soft": "rgba(19,34,27,0.07)",
      "--brand": "#0F2B21",
      "--brand-ink": "#EAF3EE",
      "--accent": "#00D084",
      "--accent-text": "#067A50",
      "--mint": "#CFF3E1",
      "--sky": "#D8E9FB",
      "--lilac": "#E6DFF6",
      "--butter": "#FBEFC9",
      "--oat": "#F4EFE6",
      "--info-text": "#1D5FA8",
      "--warn-text": "#7A5200",
      "--danger-text": "#B23030",
      "--danger-tint": "rgba(255,92,92,0.14)",
    },
    themeDark: {
      "--bg": "#0F2B21",
      "--card": "#16352A",
      "--ink": "#EAF3EE",
      "--muted": "#9DB3A9",
      "--line": "rgba(234,243,238,0.15)",
      "--line-soft": "rgba(234,243,238,0.08)",
      "--brand": "#0A1F18",
      "--brand-ink": "#EAF3EE",
      "--accent": "#00D084",
      "--accent-text": "#2FE0A2",
      "--mint": "#1C4636",
      "--sky": "#1C3A52",
      "--lilac": "#332C46",
      "--butter": "#42391C",
      "--oat": "#2E3128",
      "--info-text": "#4DA6FF",
      "--warn-text": "#FFB020",
      "--danger-text": "#FF8A8A",
      "--danger-tint": "rgba(255,92,92,0.15)",
    },
  },
  locale: {
    country: "Singapore",
    currency: "SGD",
    currencySymbol: "S$",
    timeZone: "Asia/Singapore",
    taxLabel: "9% GST",
  },
  policy: {
    version: "SG-2026.11",
    returnWindowDays: 30,
    statutoryDefectWindowMonths: 6,
    refundSettlementDays: "5 to 10 business days",
    standardShippingCents: 500,
    freeShippingThresholdCents: 8000,
    deliveryEstimate: "2 to 4 working days within Singapore",
  },
  limits: {
    autoRefundLimitCents: 20000,
    highValueReviewCents: 50000,
    defectFastTrackLimitCents: 4000,
    dailyAutoRefundBudgetCents: 200000,
    maxAutoRefundsPer30Days: 3,
  },
  risk: {
    minOrdersForElevated: 3,
    elevatedRefundRate: 0.5,
    minOrdersForHigh: 4,
    highRefundRate: 0.75,
    elevatedDefectClaims180d: 2,
    highDefectClaims180d: 3,
    highOwnershipViolations30d: 2,
    elevatedLimitFactor: 0.5,
  },
  escalation: {
    slaMinutes: { P1: 60, P2: 480, P3: 1440 },
    approverLimitsCents: {
      support_agent: 30000,
      supervisor: 150000,
      finance_manager: 100000000,
    },
    approvers: {
      "agent.lee": "support_agent",
      "sup.tan": "supervisor",
      "fin.kaur": "finance_manager",
    },
  },
  agent: {
    maxSteps: 6,
    maxToolCalls: 8,
    historyMessages: 10,
    maxMessageChars: 2000,
    maxReplyTokens: 1500,
    rateLimitPerMinute: 20,
  },
};
