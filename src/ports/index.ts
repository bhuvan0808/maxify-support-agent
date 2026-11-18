/**
 * Ports: the seams where a client's own systems plug in.
 *
 * The agent core depends only on these interfaces. To integrate with a real stack you
 * implement the relevant port (commerce platform, payment gateway, notifier, model
 * provider, SQL database) and wire it in `src/app.ts`. Nothing in `src/core` changes.
 */

import type { Cents, Customer, Identity, Order, Product } from "../core/types.ts";
import type { Priority } from "../config/tenant.ts";

// --- SQL database --------------------------------------------------------------------

export type SqlValue = string | number | null;

export interface SqlStatement {
  sql: string;
  params?: SqlValue[];
}

export interface SqlResult {
  rows: Record<string, unknown>[];
  changes: number;
}

/**
 * Minimal async SQL interface, satisfied by Cloudflare D1 and by Node's built-in SQLite.
 * `batch` is atomic: every statement commits or none does. There are no interactive
 * transactions (D1 has none), so multi-step invariants are enforced with constraints.
 */
export interface SqlDriver {
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
  all<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  first<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T | null>;
  batch(statements: SqlStatement[]): Promise<SqlResult[]>;
}

/** True when a driver error is a constraint violation of the given kind. */
export function isConstraintError(err: unknown, kind: "UNIQUE" | "CHECK"): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return new RegExp(`${kind} constraint failed`, "i").test(message);
}

// --- Commerce platform (customers, orders, catalogue, stock) ---------------------------

/** Thrown when the order system cannot be reached. The agent fails closed on this. */
export class OrderSystemUnavailable extends Error {
  constructor(message = "The order system is unavailable") {
    super(message);
    this.name = "OrderSystemUnavailable";
  }
}

export class OutOfStock extends Error {
  constructor(message = "The requested variant is out of stock") {
    super(message);
    this.name = "OutOfStock";
  }
}

export interface ExchangeRequest {
  orderId: string;
  lineId: string;
  sku: string;
  qty: number;
  newSize: string;
  newColour: string;
  idempotencyKey: string;
}

export interface CommercePort {
  findCustomerById(id: string): Promise<Customer | null>;
  findCustomerByEmail(email: string): Promise<Customer | null>;
  /** Every order belonging to this identity, with lines. Throws OrderSystemUnavailable on failure. */
  listOrdersFor(identity: Identity): Promise<Order[]>;
  /** Any order by ID, regardless of owner. Callers must check ownership. Throws OrderSystemUnavailable. */
  getOrderById(orderId: string): Promise<Order | null>;
  /** Cancels an unshipped order. Returns false if the order is no longer cancellable. */
  cancelOrder(orderId: string, idempotencyKey: string): Promise<{ ok: boolean; reference: string | null }>;
  /** Reserves replacement stock and creates the exchange shipment. Throws OutOfStock. */
  createExchange(request: ExchangeRequest): Promise<{ reference: string }>;
  getProduct(sku: string): Promise<Product | null>;
  searchProducts(query: string): Promise<Product[]>;
}

// --- Payment gateway -------------------------------------------------------------------

export class PaymentFailed extends Error {
  constructor(message = "The payment gateway rejected the refund") {
    super(message);
    this.name = "PaymentFailed";
  }
}

export interface RefundRequest {
  /** Reference of the original charge. Refunds only ever go back to the original payment method. */
  paymentRef: string;
  amountCents: Cents;
  currency: string;
  /** Passed downstream so the gateway also refuses to pay the same request twice. */
  idempotencyKey: string;
  orderId: string;
}

export interface PaymentPort {
  /** Issues a refund. Must be idempotent on `idempotencyKey`. Throws PaymentFailed. */
  refund(request: RefundRequest): Promise<{ reference: string }>;
  /** Refunds the gateway has on record, for reconciliation against the ledger. */
  listRefunds(): Promise<{ idempotencyKey: string; amountCents: Cents; reference: string }[]>;
}

// --- Notifications to humans -------------------------------------------------------------

export interface Notification {
  priority: Priority;
  title: string;
  body: string;
  /** Structured fields for the receiving system (ticket ID, customer, amount...). */
  fields: Record<string, unknown>;
}

export interface NotifierPort {
  send(notification: Notification): Promise<void>;
}

// --- Language model ----------------------------------------------------------------------

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string exactly as the model produced it. Validated before use. */
  arguments: string;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  toolCalls?: ToolCall[];
  /** For role "tool": which call this is the result of. */
  toolCallId?: string;
  name?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export interface LlmRequest {
  messages: LlmMessage[];
  tools: ToolSpec[];
  maxTokens: number;
}

export interface LlmResponse {
  content: string | null;
  toolCalls: ToolCall[];
  model: string;
  usage: { inputTokens: number; outputTokens: number } | null;
}

export class LlmUnavailable extends Error {
  constructor(
    message: string,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = "LlmUnavailable";
  }
}

export interface LlmPort {
  /** Human-readable identifier recorded in the audit log and eval output, e.g. "groq:llama-3.3-70b-versatile". */
  readonly label: string;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

// --- Clock and IDs (injected so evals are repeatable) ------------------------------------

export interface Clock {
  now(): Date;
}

export interface IdSource {
  /** Opaque unique ID for traces. */
  trace(): string;
}
