/**
 * Customer risk profile: a pure function of a customer's history.
 *
 * The profile never blocks a customer and is never shown to them or to the model.
 * It only changes how much the agent may do without a human:
 *
 *   low       normal limits, defect fast-track available
 *   elevated  reduced auto-refund limit, no defect fast-track
 *   high      every refund and exchange goes to a human, tagged for investigation
 *
 * A customer who asks for a refund on most orders therefore still gets a polite,
 * prompt answer; their request is simply decided by a person who can see the pattern.
 */

import type { TenantConfig } from "../config/tenant.ts";

export interface RiskStats {
  /** Orders that reached the customer. */
  deliveredOrders: number;
  /** Distinct orders with at least one executed refund (cancellations before shipping are not counted). */
  refundedOrders: number;
  /** Executed refunds in the last 180 days where the customer claimed a fault. */
  defectRefunds180d: number;
  /** Refunds executed without a human in the last 30 days. */
  autoRefunds30d: number;
  /** Attempts to act on an order that belongs to someone else, last 30 days. */
  ownershipViolations30d: number;
}

export type RiskTier = "low" | "elevated" | "high";

export interface RiskProfile {
  tier: RiskTier;
  /** Machine-readable reasons, shown to the human reviewer. */
  signals: string[];
  refundRate: number;
  stats: RiskStats;
}

export function assessRisk(stats: RiskStats, cfg: TenantConfig): RiskProfile {
  const r = cfg.risk;
  const refundRate = stats.deliveredOrders > 0 ? stats.refundedOrders / stats.deliveredOrders : 0;
  const high: string[] = [];
  const elevated: string[] = [];

  if (stats.deliveredOrders >= r.minOrdersForHigh && refundRate >= r.highRefundRate) {
    high.push(`REFUND_RATE_HIGH(${stats.refundedOrders}/${stats.deliveredOrders})`);
  } else if (stats.deliveredOrders >= r.minOrdersForElevated && refundRate >= r.elevatedRefundRate) {
    elevated.push(`REFUND_RATE_ELEVATED(${stats.refundedOrders}/${stats.deliveredOrders})`);
  }

  if (stats.defectRefunds180d >= r.highDefectClaims180d) {
    high.push(`DEFECT_CLAIMS_HIGH(${stats.defectRefunds180d} in 180d)`);
  } else if (stats.defectRefunds180d >= r.elevatedDefectClaims180d) {
    elevated.push(`DEFECT_CLAIMS_ELEVATED(${stats.defectRefunds180d} in 180d)`);
  }

  if (stats.ownershipViolations30d >= r.highOwnershipViolations30d) {
    high.push(`OTHER_CUSTOMERS_ORDERS_PROBED(${stats.ownershipViolations30d} in 30d)`);
  } else if (stats.ownershipViolations30d >= 1) {
    elevated.push(`OTHER_CUSTOMERS_ORDER_PROBED(${stats.ownershipViolations30d} in 30d)`);
  }

  const tier: RiskTier = high.length > 0 ? "high" : elevated.length > 0 ? "elevated" : "low";
  return { tier, signals: [...high, ...elevated], refundRate, stats };
}
