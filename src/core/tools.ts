/**
 * Tool layer: the only things the model can do.
 *
 * Read tools return facts about THIS customer's orders and the catalogue. Write tools
 * are proposals handed to the Money Gate; none of them touches a payment system.
 *
 * Design points:
 *   - No tool accepts a customer identity. Identity is bound by the channel, in code.
 *   - No tool accepts an amount. Amounts are computed from order data by the gate.
 *   - Arguments are validated with a schema before use. Unknown arguments (for example
 *     a model-invented "amount") are dropped and noted in the audit log.
 *   - If the order system is down, read tools report UNAVAILABLE instead of guessing.
 */

import { z } from "zod";
import type { TenantConfig } from "../config/tenant.ts";
import type { CommercePort, ToolSpec } from "../ports/index.ts";
import { OrderSystemUnavailable } from "../ports/index.ts";
import type { ActionService, TurnState } from "./actions.ts";
import { escalationToTurnAction } from "./actions.ts";
import type { EscalationService } from "./escalations.ts";
import { ESCALATION_CATEGORIES, RETURN_REASONS, type Order, type Product } from "./types.ts";
import { formatDay, formatMoney, safeJsonParse, truncate } from "./util.ts";

export interface ToolDeps {
  cfg: TenantConfig;
  commerce: CommercePort;
  actions: ActionService;
  escalations: EscalationService;
}

// --- Schemas shown to the model ------------------------------------------------------

const REASON_DESCRIPTION =
  "Why the customer wants this. Use a fault reason (defective_or_damaged, wrong_item_received, not_as_described) only if the customer described a fault.";

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "list_my_orders",
    description: "List this customer's orders with their items, status and dates. Use it to find the right order when the customer has not given an order number.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_order",
    description:
      "Get one of this customer's orders in detail, including what can be done with each item right now (refund, exchange, cancel). Use it to answer 'can I return this?' and 'where is my order?'.",
    parameters: {
      type: "object",
      properties: { order_id: { type: "string", description: "Order number, e.g. ORD-1001" } },
      required: ["order_id"],
      additionalProperties: false,
    },
  },
  {
    name: "search_products",
    description: "Search the product catalogue for prices, sale status, sizes and colours in stock.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Product name or keywords, e.g. 'linen shirt' or 'sale'" } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "request_refund",
    description:
      "Ask the system to refund one item of a delivered order. The system checks the policy, works out the amount and either carries it out, declines, or sends it to the team. You cannot set the amount.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        line_id: { type: "string", description: "The item's line_id from the order, e.g. ORD-1001-1" },
        reason: { type: "string", enum: [...RETURN_REASONS], description: REASON_DESCRIPTION },
        customer_quote: {
          type: "string",
          description: "Required for fault reasons: the customer's exact words describing what is wrong with the item.",
        },
        quantity: { type: "integer", minimum: 1, description: "Units to return. Omit to return all units of the item." },
        additional_to_action_id: {
          type: "string",
          description: "Only when told to by a previous result: the reference of the earlier action on this item.",
        },
      },
      required: ["order_id", "line_id", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "request_exchange",
    description:
      "Ask the system to exchange one item of a delivered order for another size and/or colour of the same product. The system checks the policy and stock.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        line_id: { type: "string", description: "The item's line_id from the order, e.g. ORD-1001-1" },
        new_size: { type: "string", description: "Size wanted instead. Omit to keep the same size." },
        new_colour: { type: "string", description: "Colour wanted instead. Omit to keep the same colour." },
        reason: { type: "string", enum: [...RETURN_REASONS], description: REASON_DESCRIPTION },
        customer_quote: { type: "string", description: "For fault reasons: the customer's exact words describing the fault." },
        quantity: { type: "integer", minimum: 1 },
        additional_to_action_id: { type: "string" },
      },
      required: ["order_id", "line_id", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "request_cancellation",
    description: "Ask the system to cancel a whole order that has not shipped yet, with a full refund.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string" },
        reason: { type: "string", description: "Why the customer is cancelling, in a few words (optional)." },
      },
      required: ["order_id"],
      additionalProperties: false,
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Hand the conversation to a human team member. Use for safety or injury, legal or chargeback threats, payment disputes, lost or missing parcels, personal-data requests, unresolved complaints, or when the customer asks for a person.",
    parameters: {
      type: "object",
      properties: {
        category: { type: "string", enum: [...ESCALATION_CATEGORIES] },
        summary: { type: "string", description: "One or two sentences a colleague can act on: what the customer wants and why." },
        order_id: { type: "string", description: "The order concerned, if any." },
      },
      required: ["category", "summary"],
      additionalProperties: false,
    },
  },
];

// --- Schemas used to validate what the model sent ----------------------------------------

const orderId = z.string().trim().min(3).max(40);
const lineId = z.string().trim().min(3).max(60);
const quantity = z.coerce.number().int().min(1).max(50).optional();
const shortText = (max: number) => z.string().trim().max(max);

const ARG_SCHEMAS = {
  list_my_orders: z.object({}),
  get_order: z.object({ order_id: orderId }),
  search_products: z.object({ query: shortText(120) }),
  request_refund: z.object({
    order_id: orderId,
    line_id: lineId,
    reason: z.enum(RETURN_REASONS),
    customer_quote: shortText(400).optional(),
    quantity,
    additional_to_action_id: shortText(40).optional(),
  }),
  request_exchange: z.object({
    order_id: orderId,
    line_id: lineId,
    new_size: shortText(30).optional(),
    new_colour: shortText(30).optional(),
    reason: z.enum(RETURN_REASONS).default("wrong_size_or_fit"),
    customer_quote: shortText(400).optional(),
    quantity,
    additional_to_action_id: shortText(40).optional(),
  }),
  request_cancellation: z.object({ order_id: orderId, reason: shortText(200).optional() }),
  escalate_to_human: z.object({
    category: z.enum(ESCALATION_CATEGORIES),
    summary: shortText(600).min(5),
    order_id: orderId.optional(),
  }),
} as const;

export type ToolName = keyof typeof ARG_SCHEMAS;

export interface ToolRun {
  /** JSON-serialisable result handed back to the model. */
  result: Record<string, unknown>;
  /** Arguments after validation, for the audit log. */
  args: Record<string, unknown>;
  /** Argument names the model sent that no tool accepts. */
  ignoredArgs: string[];
}

// --- Rendering -------------------------------------------------------------------------

function renderOrder(order: Order, cfg: TenantConfig, detailed: boolean): Record<string, unknown> {
  const tz = cfg.locale.timeZone;
  const sym = cfg.locale.currencySymbol;
  return {
    order_id: order.id,
    status: order.status,
    placed: formatDay(order.placedAt, tz),
    ...(order.shippedAt ? { shipped: formatDay(order.shippedAt, tz) } : {}),
    ...(order.deliveredAt ? { delivered: formatDay(order.deliveredAt, tz) } : {}),
    ...(order.cancelledAt ? { cancelled: formatDay(order.cancelledAt, tz) } : {}),
    total_paid: formatMoney(order.totalPaidCents, sym),
    ...(detailed
      ? {
          shipping_paid: order.shippingCents === 0 ? "free" : formatMoney(order.shippingCents, sym),
          paid_with: order.paymentMethod,
        }
      : {}),
    items: order.lines.map((l) => ({
      line_id: l.id,
      name: l.name,
      size: l.size,
      colour: l.colour,
      qty: l.qty,
      paid_each: formatMoney(l.unitPaidCents, sym),
      bought_on_sale: l.purchasedOnSale,
      ...(l.hygiene ? { hygiene_item: true } : {}),
    })),
  };
}

function renderProduct(p: Product, cfg: TenantConfig): Record<string, unknown> {
  const sym = cfg.locale.currencySymbol;
  const inStock = p.variants.filter((v) => v.stock > 0).map((v) => `${v.size} ${v.colour}`);
  const soldOut = p.variants.filter((v) => v.stock === 0).map((v) => `${v.size} ${v.colour}`);
  return {
    name: p.name,
    sku: p.sku,
    category: p.category,
    price: formatMoney(p.salePriceCents ?? p.priceCents, sym),
    ...(p.salePriceCents !== null ? { on_sale: true, was: formatMoney(p.priceCents, sym) } : { on_sale: false }),
    ...(p.hygiene ? { hygiene_item: true } : {}),
    description: p.description,
    in_stock: inStock,
    ...(soldOut.length > 0 ? { sold_out: soldOut } : {}),
  };
}

const UNAVAILABLE = {
  error: "UNAVAILABLE",
  say: "The order system can't be reached right now, so order details can't be looked up and nothing has been changed. The request is being passed to the team to follow up.",
};

// --- Dispatcher ------------------------------------------------------------------------

export function isToolName(name: string): name is ToolName {
  return name in ARG_SCHEMAS;
}

export async function runTool(name: string, rawArguments: string, turn: TurnState, deps: ToolDeps): Promise<ToolRun> {
  if (!isToolName(name)) {
    return { result: { error: "UNKNOWN_TOOL", say: `There is no tool called ${truncate(name, 40)}.` }, args: {}, ignoredArgs: [] };
  }

  const parsed = safeJsonParse<unknown>(rawArguments?.trim() ? rawArguments : "{}", undefined);
  if (parsed === undefined || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      result: { error: "INVALID_ARGUMENTS", say: "The arguments were not a valid JSON object. Nothing was done." },
      args: {},
      ignoredArgs: [],
    };
  }
  // Models often send null or "" for optional fields; treat those as absent.
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value !== null && value !== "") cleaned[key] = value;
  }
  const schema = ARG_SCHEMAS[name];
  const ignoredArgs = Object.keys(cleaned).filter((k) => !(k in schema.shape));
  const validated = schema.safeParse(cleaned);
  if (!validated.success) {
    const problems = validated.error.issues.map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ");
    return {
      result: { error: "INVALID_ARGUMENTS", say: `Nothing was done. Fix the arguments and try again: ${truncate(problems, 300)}` },
      args: cleaned,
      ignoredArgs,
    };
  }
  const args = validated.data as Record<string, unknown>;
  const note = ignoredArgs.length > 0 ? { ignored_arguments: ignoredArgs, note: "Amounts and other extra fields are set by the system, not by you." } : {};

  try {
    const result = await dispatch(name, args, turn, deps);
    if (typeof result.say === "string" && name.startsWith("request_")) turn.says.push(result.say);
    if (typeof result.say === "string" && name === "escalate_to_human") turn.says.push(result.say);
    return { result: { ...result, ...note }, args, ignoredArgs };
  } catch (err) {
    if (err instanceof OrderSystemUnavailable) {
      turn.lookupFailed = true;
      turn.audit.record("order_lookup_failed", { during: name });
      return { result: UNAVAILABLE, args, ignoredArgs };
    }
    throw err;
  }
}

async function dispatch(
  name: ToolName,
  args: Record<string, unknown>,
  turn: TurnState,
  deps: ToolDeps,
): Promise<Record<string, unknown>> {
  const { cfg, actions, commerce, escalations } = deps;

  switch (name) {
    case "list_my_orders": {
      const orders = await actions.ordersFor(turn);
      if (orders.length === 0) {
        return {
          orders: [],
          say:
            turn.identity.kind === "unrecognised"
              ? "No account or orders match the details supplied."
              : "There are no orders under this customer's details.",
        };
      }
      return { orders: orders.map((o) => renderOrder(o, cfg, false)) };
    }

    case "get_order": {
      const { order } = await actions.lookupOrder(String(args.order_id), turn);
      if (!order) {
        return {
          error: "ORDER_NOT_FOUND",
          say: `No order ${String(args.order_id).toUpperCase()} was found under this customer's details. Ask them to check the order number.`,
        };
      }
      const options = await actions.describeOptions(order, turn);
      const rendered = renderOrder(order, cfg, true) as { items: Record<string, unknown>[] };
      rendered.items = rendered.items.map((item) => ({ ...item, options: options.lines[String(item.line_id)] }));
      return { ...rendered, cancel_order: options.cancel };
    }

    case "search_products": {
      const products = await commerce.searchProducts(String(args.query));
      if (products.length === 0) return { products: [], say: "No products matched that search." };
      return { products: products.map((p) => renderProduct(p, cfg)) };
    }

    case "request_refund": {
      const outcome = await actions.propose(
        {
          type: "refund",
          orderId: String(args.order_id).toUpperCase(),
          lineId: String(args.line_id).toUpperCase(),
          reason: args.reason as (typeof RETURN_REASONS)[number],
          qty: args.quantity as number | undefined,
          evidenceQuote: args.customer_quote as string | undefined,
          additionalToActionId: args.additional_to_action_id as string | undefined,
        },
        turn,
      );
      return outcome.forModel;
    }

    case "request_exchange": {
      const outcome = await actions.propose(
        {
          type: "exchange",
          orderId: String(args.order_id).toUpperCase(),
          lineId: String(args.line_id).toUpperCase(),
          reason: args.reason as (typeof RETURN_REASONS)[number],
          qty: args.quantity as number | undefined,
          newSize: args.new_size as string | undefined,
          newColour: args.new_colour as string | undefined,
          evidenceQuote: args.customer_quote as string | undefined,
          additionalToActionId: args.additional_to_action_id as string | undefined,
        },
        turn,
      );
      return outcome.forModel;
    }

    case "request_cancellation": {
      const outcome = await actions.propose(
        { type: "cancellation", orderId: String(args.order_id).toUpperCase(), reason: args.reason as string | undefined },
        turn,
      );
      return outcome.forModel;
    }

    case "escalate_to_human": {
      // Attach an order only if it really is this customer's.
      let attachedOrderId: string | null = null;
      if (args.order_id) {
        try {
          const { order } = await actions.lookupOrder(String(args.order_id), turn);
          attachedOrderId = order?.id ?? null;
        } catch (err) {
          if (!(err instanceof OrderSystemUnavailable)) throw err;
          // The hand-over itself must still work during an outage.
        }
      }
      const category = args.category as (typeof ESCALATION_CATEGORIES)[number];
      const { record, created } = await escalations.open(
        {
          category,
          codes: ["MODEL_HANDOVER"],
          identity: turn.identity,
          orderId: attachedOrderId,
          lineId: null,
          proposedAction: null,
          summary: String(args.summary),
          riskSnapshot: {},
          conversationId: turn.conversationId,
          traceId: turn.traceId,
        },
        turn.audit,
      );
      const asTurn = escalationToTurnAction(record, cfg);
      if (created) turn.actions.push(asTurn);
      else turn.duplicates.push(asTurn);
      const respondBy = escalations.respondBy(record.priority);
      return {
        outcome: created ? "ESCALATED" : "ALREADY_DONE",
        reference: record.id,
        respond_by: respondBy,
        say: created
          ? `This has been passed to a team member (reference ${record.id}). They will reply ${respondBy}.`
          : `This is already with a team member (reference ${record.id}). They will reply ${respondBy}.`,
      };
    }
  }
}
