/**
 * CommercePort backed by the seeded tables: a stand-in for the client's real
 * commerce platform (Shopify, Magento, a custom OMS...).
 *
 * To integrate a real platform, implement `CommercePort` against its API and swap it
 * in `src/app.ts`. The agent core never reads these tables directly.
 *
 * Fault injection: when `faults.orderLookupFails()` is true, every order lookup throws
 * `OrderSystemUnavailable`, exactly as a timeout or 5xx from a real order system would.
 */

import type { Clock, CommercePort, ExchangeRequest, SqlDriver } from "../../ports/index.ts";
import { OrderSystemUnavailable, OutOfStock, isConstraintError } from "../../ports/index.ts";
import type { Customer, Identity, Order, OrderLine, OrderStatus, Product } from "../../core/types.ts";
import { nextId } from "../../store/ids.ts";

interface OrderRow {
  id: string;
  customer_id: string | null;
  guest_email: string | null;
  status: OrderStatus;
  placed_at: string;
  shipped_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  shipping_cents: number;
  total_paid_cents: number;
  currency: string;
  payment_method: string;
  payment_ref: string;
}

interface ItemRow {
  id: string;
  order_id: string;
  line_no: number;
  sku: string;
  name: string;
  size: string;
  colour: string;
  qty: number;
  unit_paid_cents: number;
  purchased_on_sale: number;
  hygiene: number;
}

interface ProductRow {
  sku: string;
  name: string;
  category: string;
  price_cents: number;
  sale_price_cents: number | null;
  hygiene: number;
  description: string;
}

interface InventoryRow {
  sku: string;
  size: string;
  colour: string;
  stock: number;
}

function toLine(row: ItemRow): OrderLine {
  return {
    id: row.id,
    orderId: row.order_id,
    lineNo: row.line_no,
    sku: row.sku,
    name: row.name,
    size: row.size,
    colour: row.colour,
    qty: row.qty,
    unitPaidCents: row.unit_paid_cents,
    purchasedOnSale: row.purchased_on_sale === 1,
    hygiene: row.hygiene === 1,
  };
}

function toOrders(orderRows: OrderRow[], itemRows: ItemRow[]): Order[] {
  const linesByOrder = new Map<string, OrderLine[]>();
  for (const item of itemRows) {
    const list = linesByOrder.get(item.order_id) ?? [];
    list.push(toLine(item));
    linesByOrder.set(item.order_id, list);
  }
  return orderRows.map((o) => ({
    id: o.id,
    customerId: o.customer_id,
    guestEmail: o.guest_email,
    status: o.status,
    placedAt: o.placed_at,
    shippedAt: o.shipped_at,
    deliveredAt: o.delivered_at,
    cancelledAt: o.cancelled_at,
    shippingCents: o.shipping_cents,
    totalPaidCents: o.total_paid_cents,
    currency: o.currency,
    paymentMethod: o.payment_method,
    paymentRef: o.payment_ref,
    lines: linesByOrder.get(o.id) ?? [],
  }));
}

function toProducts(productRows: ProductRow[], inventoryRows: InventoryRow[]): Product[] {
  return productRows.map((p) => ({
    sku: p.sku,
    name: p.name,
    category: p.category,
    priceCents: p.price_cents,
    salePriceCents: p.sale_price_cents,
    hygiene: p.hygiene === 1,
    description: p.description,
    variants: inventoryRows
      .filter((i) => i.sku === p.sku)
      .map((i) => ({ size: i.size, colour: i.colour, stock: i.stock })),
  }));
}

export interface CommerceFaults {
  orderLookupFails(): boolean;
}

export class LocalCommerce implements CommercePort {
  constructor(
    private readonly sql: SqlDriver,
    private readonly clock: Clock,
    private readonly faults: CommerceFaults,
  ) {}

  async findCustomerById(id: string): Promise<Customer | null> {
    return this.sql.first<Customer>(`SELECT id, name, email FROM customers WHERE id = ?`, [id]);
  }

  async findCustomerByEmail(email: string): Promise<Customer | null> {
    return this.sql.first<Customer>(`SELECT id, name, email FROM customers WHERE lower(email) = ?`, [
      email.toLowerCase(),
    ]);
  }

  async listOrdersFor(identity: Identity): Promise<Order[]> {
    if (this.faults.orderLookupFails()) throw new OrderSystemUnavailable();
    if (identity.kind === "unrecognised") return [];
    // A signed-in customer also sees guest orders placed with their account email.
    const params = [identity.customerId ?? "", (identity.email ?? "").toLowerCase()];
    const where = `(customer_id = ? AND customer_id <> '') OR (guest_email IS NOT NULL AND lower(guest_email) = ? AND guest_email <> '')`;
    const [orders, items] = await this.sql.batch([
      { sql: `SELECT * FROM orders WHERE ${where} ORDER BY placed_at DESC`, params },
      {
        sql: `SELECT * FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE ${where}) ORDER BY order_id, line_no`,
        params,
      },
    ]);
    return toOrders((orders?.rows ?? []) as unknown as OrderRow[], (items?.rows ?? []) as unknown as ItemRow[]);
  }

  async getOrderById(orderId: string): Promise<Order | null> {
    if (this.faults.orderLookupFails()) throw new OrderSystemUnavailable();
    const [orders, items] = await this.sql.batch([
      { sql: `SELECT * FROM orders WHERE id = ?`, params: [orderId] },
      { sql: `SELECT * FROM order_items WHERE order_id = ? ORDER BY line_no`, params: [orderId] },
    ]);
    return (
      toOrders((orders?.rows ?? []) as unknown as OrderRow[], (items?.rows ?? []) as unknown as ItemRow[])[0] ?? null
    );
  }

  async cancelOrder(orderId: string, _idempotencyKey: string): Promise<{ ok: boolean; reference: string | null }> {
    // The status guard makes this safe against a shipment racing the cancellation.
    const result = await this.sql.run(
      `UPDATE orders SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status = 'processing'`,
      [this.clock.now().toISOString(), orderId],
    );
    if (result.changes !== 1) return { ok: false, reference: null };
    return { ok: true, reference: await nextId(this.sql, "CANC") };
  }

  async createExchange(request: ExchangeRequest): Promise<{ reference: string }> {
    const existing = await this.sql.first<{ reference: string }>(
      `SELECT reference FROM exchanges WHERE idempotency_key = ?`,
      [request.idempotencyKey],
    );
    if (existing) return existing;

    const stock = await this.sql.first<{ stock: number }>(
      `SELECT stock FROM inventory WHERE sku = ? AND size = ? AND colour = ?`,
      [request.sku, request.newSize, request.newColour],
    );
    if (!stock || stock.stock < request.qty) throw new OutOfStock();

    const reference = await nextId(this.sql, "EXCH");
    try {
      // One transaction: stock leaves and the exchange is recorded together. The CHECK
      // (stock >= 0) on inventory rejects the batch if a concurrent order took the last unit.
      await this.sql.batch([
        {
          sql: `UPDATE inventory SET stock = stock - ? WHERE sku = ? AND size = ? AND colour = ?`,
          params: [request.qty, request.sku, request.newSize, request.newColour],
        },
        {
          sql: `INSERT INTO exchanges (reference, idempotency_key, order_id, line_id, sku, size, colour, qty, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            reference,
            request.idempotencyKey,
            request.orderId,
            request.lineId,
            request.sku,
            request.newSize,
            request.newColour,
            request.qty,
            this.clock.now().toISOString(),
          ],
        },
      ]);
    } catch (err) {
      if (isConstraintError(err, "CHECK")) throw new OutOfStock();
      if (isConstraintError(err, "UNIQUE")) {
        const again = await this.sql.first<{ reference: string }>(
          `SELECT reference FROM exchanges WHERE idempotency_key = ?`,
          [request.idempotencyKey],
        );
        if (again) return again;
      }
      throw err;
    }
    return { reference };
  }

  async getProduct(sku: string): Promise<Product | null> {
    const [products, inventory] = await this.sql.batch([
      { sql: `SELECT * FROM products WHERE sku = ?`, params: [sku] },
      { sql: `SELECT * FROM inventory WHERE sku = ? ORDER BY size, colour`, params: [sku] },
    ]);
    return (
      toProducts(
        (products?.rows ?? []) as unknown as ProductRow[],
        (inventory?.rows ?? []) as unknown as InventoryRow[],
      )[0] ?? null
    );
  }

  async searchProducts(query: string): Promise<Product[]> {
    const [products, inventory] = await this.sql.batch([
      { sql: `SELECT * FROM products ORDER BY sku` },
      { sql: `SELECT * FROM inventory ORDER BY sku, size, colour` },
    ]);
    const all = toProducts(
      (products?.rows ?? []) as unknown as ProductRow[],
      (inventory?.rows ?? []) as unknown as InventoryRow[],
    );
    // The catalogue is small, so rank in memory: count how many query words each product matches.
    const words = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3);
    if (words.length === 0) return all.slice(0, 6);
    const wantsSale = words.some((w) => ["sale", "discount", "discounted", "offer", "promo"].includes(w));
    const scored = all
      .map((p) => {
        const text = `${p.name} ${p.category} ${p.description} ${p.sku}`.toLowerCase();
        // Match on word stems so "shirts" finds "shirt" and "sneaker" finds "sneakers".
        let score = words.filter((w) => text.includes(w) || text.includes(w.replace(/s$/, ""))).length;
        if (wantsSale && p.salePriceCents !== null) score += 2;
        return { p, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, 6).map((x) => x.p);
  }
}
