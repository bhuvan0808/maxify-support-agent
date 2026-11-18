/**
 * PaymentPort backed by a local table: a stand-in for a real gateway (Stripe, Adyen...).
 *
 * It behaves like a real gateway in the two ways that matter for safety:
 *   - it is idempotent: the same idempotency key always returns the same refund;
 *   - it can fail: `faults.paymentFails()` makes every refund throw `PaymentFailed`.
 *
 * It keeps its own record of refunds (`gateway_refunds`), separate from the agent's
 * ledger, so the two can be reconciled against each other.
 */

import type { Clock, PaymentPort, RefundRequest, SqlDriver } from "../../ports/index.ts";
import { PaymentFailed, isConstraintError } from "../../ports/index.ts";
import { nextId } from "../../store/ids.ts";

export interface PaymentFaults {
  paymentFails(): boolean;
}

export class MockPaymentGateway implements PaymentPort {
  constructor(
    private readonly sql: SqlDriver,
    private readonly clock: Clock,
    private readonly faults: PaymentFaults,
  ) {}

  private existing(idempotencyKey: string) {
    return this.sql.first<{ reference: string }>(`SELECT reference FROM gateway_refunds WHERE idempotency_key = ?`, [
      idempotencyKey,
    ]);
  }

  async refund(request: RefundRequest): Promise<{ reference: string }> {
    if (this.faults.paymentFails()) throw new PaymentFailed();
    if (request.amountCents <= 0) throw new PaymentFailed("Refund amount must be positive");

    const already = await this.existing(request.idempotencyKey);
    if (already) return already;

    const reference = await nextId(this.sql, "RFND");
    try {
      await this.sql.run(
        `INSERT INTO gateway_refunds (reference, idempotency_key, payment_ref, order_id, amount_cents, currency, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          reference,
          request.idempotencyKey,
          request.paymentRef,
          request.orderId,
          request.amountCents,
          request.currency,
          this.clock.now().toISOString(),
        ],
      );
    } catch (err) {
      // A concurrent request with the same key won the race: return its refund, pay nothing more.
      if (isConstraintError(err, "UNIQUE")) {
        const winner = await this.existing(request.idempotencyKey);
        if (winner) return winner;
      }
      throw err;
    }
    return { reference };
  }

  async listRefunds(): Promise<{ idempotencyKey: string; amountCents: number; reference: string }[]> {
    const rows = await this.sql.all<{ idempotency_key: string; amount_cents: number; reference: string }>(
      `SELECT idempotency_key, amount_cents, reference FROM gateway_refunds ORDER BY created_at`,
    );
    return rows.map((r) => ({ idempotencyKey: r.idempotency_key, amountCents: r.amount_cents, reference: r.reference }));
  }
}
