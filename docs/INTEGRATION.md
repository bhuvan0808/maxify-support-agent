# Integration guide

How a client connects this agent to its own systems. There are three kinds of connection, and each is independent of the others:

1. **Inbound:** your chat or helpdesk sends customer messages to the agent.
2. **Outbound:** the agent reads orders and issues refunds through your commerce platform and payment gateway.
3. **Human loop:** your team is notified of tickets and approves or rejects them.

What ships in this build is the channel-neutral API, a web chat page, an ops console, and stand-in adapters that run on seeded data. **No vendor-specific adapter (Zendesk, Intercom, Freshdesk, WhatsApp) ships.** The section "Connecting a helpdesk" says what one takes.

## 1. Inbound: send a message

```http
POST /v1/chat
content-type: application/json

{ "customer_id": "C001", "message": "Where is my order?", "conversation_id": "ticket-8841" }
```

Use `guest_email` in place of `customer_id` for a shopper without an account. Exactly one of the two.

```json
{
  "traceId": "…",
  "conversationId": "cust:C001#ticket-8841",
  "reply": "…",
  "actions": [
    { "type": "refund", "id": "ACT-000001", "status": "executed", "orderId": "ORD-1001",
      "lineId": "ORD-1001-1", "amountCents": 6900, "amount": "S$69.00",
      "priority": null, "category": null, "reference": "RFND-000001", "detail": "…" }
  ],
  "duplicatesRecognised": [],
  "notices": []
}
```

- `actions` holds what was newly done in this turn: `refund`, `exchange`, `cancellation` or `escalation`. An `escalation` entry is your signal to hand the conversation to a person; it carries `priority` and `category`.
- `duplicatesRecognised` holds earlier actions this request matched.
- `conversation_id` is optional. It is scoped to the identity, so one customer cannot read another's thread by guessing an ID.

**The identity you send is trusted.** The agent does not log customers in. Send the customer ID your site or helpdesk has already authenticated; never pass through an ID the customer typed into the chat. For guests, verify the email (a one-time code, for example) before sending it; this build does not do that step.

**Protect the endpoint.** Put the API behind your own authentication (an API gateway, Cloudflare Access, or a bearer check in the Worker) and call it server-to-server. `.env.example` reserves `CHANNEL_API_KEY` for this; see the header of `src/worker.ts` for what this build enforces. The public demo is open so it can be tested.

### Connecting a helpdesk

A vendor adapter is roughly three functions, about 50 to 100 lines:

1. **Receive:** verify the vendor's webhook signature and turn its "new customer message" event into `{ customer_id | guest_email, message, conversation_id }`, using the identity the vendor holds for that conversation.
2. **Ask:** call `POST /v1/chat` (or `app.agent.handle(...)` in-process).
3. **Respond:** post `reply` back through the vendor's API. If `actions` contains an `escalation`, assign the conversation to the vendor's human team or queue and add the ticket reference as an internal note.

Field names differ per vendor and are not documented here because none was tested against a live account.

## 2. Outbound: your systems behind the agent

Every external system is an interface in [src/ports/index.ts](../src/ports/index.ts). Implement the ones you need and swap them in [src/app.ts](../src/app.ts), which is the only file that binds ports to adapters (`createApp` also accepts `commerce`, `payments` and `llm` overrides). Nothing in `src/core` changes.

| Port | What you implement | Bundled stand-in |
|---|---|---|
| `CommercePort` | `findCustomerById`, `findCustomerByEmail`, `listOrdersFor`, `getOrderById`, `cancelOrder`, `createExchange`, `getProduct`, `searchProducts` | `src/adapters/commerce/local.ts` (seeded tables) |
| `PaymentPort` | `refund` (must be idempotent on the key it is given), `listRefunds` (for reconciliation) | `src/adapters/payments/mock.ts` |
| `NotifierPort` | `send({ priority, title, body, fields })` | `src/adapters/notify/outbox.ts` (outbox table plus optional webhook) |
| `LlmPort` | `complete({ messages, tools, maxTokens })` | `src/adapters/llm/openaiCompatible.ts` |
| `SqlDriver` | `run`, `all`, `first`, `batch` (atomic) | `src/adapters/sql/d1.ts`, `src/adapters/sql/nodeSqlite.ts` |

Rules an adapter must keep:

- **Throw `OrderSystemUnavailable`** when your order system cannot be reached. The agent then fails closed: no action, an honest reply, a ticket.
- **Throw `PaymentFailed`** when a refund is rejected. The agent releases the reservation and raises an urgent ticket.
- **Pass the idempotency key on** to your gateway. It is what stops a retry from paying twice.
- **Map your data to the types in `src/core/types.ts`.** Two fields carry policy: `OrderLine.purchasedOnSale` (was this unit bought at a sale price) and `OrderLine.hygiene`. `Order.status` must be one of `processing`, `shipped`, `delivered`, `cancelled`, and `deliveredAt` must be set for delivered orders.
- **`cancelOrder` must refuse** an order that is no longer cancellable and return `ok: false`.

The agent keeps its own ledger of what it has refunded and exchanged, so its safety checks do not depend on your order system reflecting a refund immediately.

**Model provider.** Any OpenAI-compatible endpoint with tool calling works by setting `LLM_BASE_URL`, `LLM_MODEL` and a key. No native Anthropic adapter ships; Anthropic's OpenAI-compatible endpoint can be tried the same way, which is untested. For anything else, implement `LlmPort`.

**Database.** The schema is plain SQLite SQL in `src/store/schema.ts`. Moving to another SQL engine means implementing `SqlDriver` and porting the partial unique index and the `CHECK` constraints, which carry the money invariants.

## 3. Human loop

**Notifications.** Every new ticket writes a row to the `notifications` table and, if `NOTIFY_WEBHOOK_URL` is set, sends:

```json
{
  "text": "[P2] Fault claim to verify: ESC-000003 (ORD-1005 S$104.30)\n<summary>",
  "priority": "P2",
  "title": "Fault claim to verify: ESC-000003 (ORD-1005 S$104.30)",
  "body": "<summary a reviewer can act on>",
  "fields": { "escalationId": "ESC-000003", "category": "defect_verification", "customer": "cust:C002",
              "orderId": "ORD-1005", "lineId": "ORD-1005-1", "codes": ["…"], "respondBy": "…", "risk": { } }
}
```

The `text` field makes a Slack or Teams incoming webhook work as-is. The request is not signed (not implemented), so use a secret URL. To create tickets in your helpdesk instead, implement `NotifierPort`.

**Decisions.** All admin routes need `Authorization: Bearer <ADMIN_API_KEY>`.

| Route | Purpose |
|---|---|
| `GET /v1/admin/escalations?status=open` | The queue, ordered by priority then respond-by time |
| `POST /v1/admin/escalations/:id/decision` | Body `{ "decision": "approve" \| "reject", "approver_id": "sup.tan", "note": "…" }` |
| `GET /v1/admin/actions` | The ledger |
| `GET /v1/admin/notifications` | The notification outbox |
| `GET /v1/admin/audit?trace_id=…` | Audit events for one turn |
| `GET /v1/admin/audit/verify` | Recompute the audit hash chains |
| `POST /v1/admin/reset` | Wipe and re-seed (demo only; remove or lock down in production) |

A decision returns a result code: `APPROVED_AND_EXECUTED`, `ACKNOWLEDGED` (ticket without a proposed action), `REJECTED`, `ALREADY_DECIDED`, `APPROVER_LIMIT_EXCEEDED`, `NOT_EXECUTABLE` (the order changed since the ticket was raised), `EXECUTION_FAILED` (ticket reopened), `SYSTEM_UNAVAILABLE`, `UNKNOWN_APPROVER`, `NOT_FOUND`.

Approvers and their budgets are a list in `src/config/tenant.ts`. In production, replace that lookup with roles from your identity provider; the single shared admin key is a demo arrangement.

The customer learns the outcome the next time they write: the agent is shown the ticket's status. Pushing the outcome to the customer proactively is not implemented; do it from your helpdesk when a decision is made.

## Re-branding and tuning

Everything a client normally changes is in [src/config/tenant.ts](../src/config/tenant.ts):

- `brand`: store name, assistant name, support email, and the light and dark theme as CSS custom properties, served to the web pages through `GET /v1/config/public`. The default theme uses the gomaxify.ai palette.
- `policy`: return window, statutory fault window, shipping and delivery wording, policy version.
- `limits`: auto-refund limit, high-value threshold, fault fast-track limit, daily budget, refunds per customer per 30 days.
- `risk`: the thresholds for elevated and high risk.
- `escalation`: reply times per priority, approver budgets.
- `agent`: step and tool-call caps, history length, message size, rate limit.

Policy numbers are rendered into the prompt from this object, so the assistant's wording and the gate's behaviour change together. Bump `policy.version` when you change a rule; it is stored on every decision.

## From Singapore to another market

1. Copy `defaultTenant` and change `locale` (country, currency, symbol, IANA time zone, tax label). Calendar-day maths uses the time zone, including across daylight-saving changes.
2. Set the `policy` numbers for that market: the return window, and `statutoryDefectWindowMonths` for the local equivalent of the Lemon Law (for example a longer legal guarantee period).
3. Adjust `limits` to the currency.
4. Pass the config to `createApp({ cfg })`. One deployment per market, or choose the config per request from the channel.

What configuration does **not** cover, and would need code: a statutory cooling-off right that overrides the sale-item rule (a change in `src/core/gate.ts`), replies in other languages (the fixed fallback and gate sentences are in English), and money formats other than symbol, thousands comma and two decimals.

## Checklist before production

- [ ] Real `CommercePort` and `PaymentPort`, tested against sandbox accounts
- [ ] Authentication in front of `POST /v1/chat`; identity taken from your session, not from the chat
- [ ] Approver identity from single sign-on in place of the shared admin key
- [ ] `POST /v1/admin/reset` removed or locked down
- [ ] Data-processing and transfer terms with the model provider
- [ ] Retention schedule for transcripts and the audit log
- [ ] Notification webhook pointed at a monitored channel
- [ ] `npm run eval:gate` and `npm run eval:adversarial` passing, and `npm run eval:live` run against the chosen model
