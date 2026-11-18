# Architecture

## Verdict on the reference diagram

Reference: `maxify_agent_01.json` (six layers plus cross-cutting controls).

**Its core is sound and was kept.** The model proposes and never executes; a deterministic Money Gate decides ALLOW, DENY or NEEDS HUMAN; one executor writes intent to a ledger, calls the payment adapter and commits; an output guard checks the reply against the ledger; an append-only audit log, idempotency keys, a kill switch, fault injection and reconciliation surround it. That is the right shape for an agent that moves money.

**It was not ready to hand to a client as drawn.** What it lacked, and what this build adds:

| Gap in the diagram | Added |
|---|---|
| One channel (CLI/API) and "adapters" only for payment and OMS | Ports for commerce, payment, notifier, model and SQL (`src/ports/index.ts`), bound in one file (`src/app.ts`). A channel-neutral HTTP API and a web chat page |
| Human queue with no way back | Approval return path: an approver's decision re-checks the order and runs the same executor. Approver budgets by role, priorities and respond-by times, priority notifications |
| No view of the customer | Risk profile from history (refund rate, defect claims, attempts on others' orders) that changes what needs a human, without the customer or the model being told |
| Policy hard-wired | Tenant config: currency, time zone, policy numbers, limits, statutory window, theme. Singapore first, other markets by configuration |
| "Unverified defect claim → human" with no mechanism | Fault claims must quote the customer's own words, checked in code; a capped fast track for low-value cases |
| No statutory route | Fault claims inside 6 months are never auto-denied (Singapore Lemon Law) |
| Idempotency in application code only | The database itself refuses over-refund, over-quantity and duplicate live actions (constraints) |
| "Append-only" audit log | Hash-chained per conversation, with database triggers that reject edits and deletions, and a verifier |
| Lookup failure "apologise + escalate" left to the model | Done in code after the model speaks, with fixed wording |

Not carried over as drawn: "traces, metrics, alerts" (the audit log and notification outbox exist; no metrics pipeline) and a *scheduled* reconciliation job (reconciliation is a command, `npm run reconcile`, not a schedule).

## Layers

```text
 Channels            CLI (src/cli.ts)      HTTP API + web chat + ops console (src/worker.ts, public/)
                              \                 /
 Composition                   src/app.ts  (binds ports to adapters, reads env)
                                      |
 Agent turn          src/core/agent.ts
                       identity -> input guard -> load state -> model loop -> post-conditions -> output guard -> persist
                                      |
 Model (untrusted)   LlmPort  <- adapters/llm/openaiCompatible.ts | scripted.ts
                                      |  tool calls
 Tools               src/core/tools.ts
                       read:  list_my_orders, get_order, search_products
                       write: request_refund, request_exchange, request_cancellation, escalate_to_human
                                      |  proposals
 Money Gate          src/core/gate.ts   (pure function; uses src/core/risk.ts)
                       ALLOW            DENY               NEEDS_HUMAN           DUPLICATE
                         |                |                     |                    |
 Execution           src/core/actions.ts  explain +        src/core/escalations.ts  return the
                       reserve -> call      alternatives     ticket + priority +     existing
                       out -> commit                         notification            reference
                         |                                       |
 Ports               CommercePort, PaymentPort                NotifierPort          <- approver decision
                     adapters/commerce/local.ts                adapters/notify/         (actions.decideEscalation,
                     adapters/payments/mock.ts                 outbox.ts                 same executor)
                                      |
 State               SqlDriver <- adapters/sql/d1.ts (Workers) | nodeSqlite.ts (CLI, evals)
                       ledger, tickets, conversation, audit log (src/store/schema.ts)
 Cross-cutting       src/core/audit.ts (hash chain)   src/core/guards.ts   src/config/tenant.ts
```

`src/core` imports no adapter and nothing Node- or Workers-specific. The CLI, the Worker and the evals all call `createApp`, so they run the same agent.

## One request, step by step

1. **Identity.** The channel supplies a customer ID or guest email. It is resolved once (`resolveIdentity`); an unknown ID becomes "unrecognised", which can ask general questions only. The conversation ID is prefixed with the identity, so a thread ID cannot be used to read another customer's history.
2. **Input guard.** Length cap, control characters stripped, card numbers, security codes and NRIC/FIN numbers removed, injection phrasing noted for the audit log.
3. **State.** The last 10 messages of the conversation plus this customer's recent actions and tickets. The latter are rendered into the prompt as PRIOR ACTIONS so a repeat is visible to the model.
4. **Model loop.** At most 6 round-trips and 8 tool calls. An identical tool call repeated within a turn is not run twice.
5. **Tools.** Read tools return only this identity's orders. `get_order` also returns, per item, what is possible right now; that comes from a dry run of the gate, so the model does no date or policy arithmetic.
6. **Proposal.** A `request_*` tool loads the facts for the order in one batched query and calls `evaluate()`.
7. **Outcome.** ALLOW goes to the executor. NEEDS_HUMAN opens a ticket carrying the exact proposed action. DENY and DUPLICATE return customer-safe wording. The model sees a customer-safe code and sentence; reason codes such as risk review or limit exceeded go only to the audit log and the ticket.
8. **Post-conditions, in code.** If any order lookup failed, the reply is replaced with fixed outage wording and a ticket is opened. If the model failed, a safe reply and a ticket.
9. **Output guard.** The reply must agree with the ledger or it is replaced by one built from the gate's own sentences.
10. **Persist.** Both messages are stored and the audit buffer is flushed. The result returns `reply`, `actions`, `duplicatesRecognised`, `notices`, `traceId`.

## Execution: reserve, call out, commit

`ActionService.execute` in `src/core/actions.ts`:

1. Write `action_intent` to the audit log and flush it, so the decision is on disk before anything moves.
2. **Reserve**, in one transaction: insert the action as `pending` and add its units and money to the ledger counters. This fails if the same request is already live or if it would exceed what was bought or paid.
3. **Call out** to the order system or payment gateway with the same idempotency key.
4. **Commit** as `executed`; or mark `failed`, release the reservation and raise a P1 ticket.

Human approval (`decideEscalation`) claims the ticket with a status-guarded update so only one decision wins, re-evaluates the proposal in `human_approved` mode (policy and risk are the approver's call; ownership, order state, quantities and amounts are still enforced), checks the approver's budget, then calls the same `execute`.

## Data model

| Group | Tables | Notes |
|---|---|---|
| Stand-in commerce platform | `customers`, `products`, `inventory`, `orders`, `order_items`, `exchanges` | Touched only through `CommercePort` |
| Stand-in payment gateway | `gateway_refunds` | Its own record, unique on idempotency key |
| Agent ledger | `actions`, `ledger_orders`, `ledger_lines`, `escalations`, `risk_events` | The agent's own counters, independent of the client's order system |
| Conversation and control | `messages`, `audit_log`, `notifications`, `rate_limits`, `counters`, `meta` | |

Each `actions` row records type, status, amount, reason, idempotency key, reason codes, policy version, origin (`agent`, `human` or `seed`), approver, ticket, gateway reference and trace ID.

## Money-safety properties and where each is enforced

| Property | Enforced in |
|---|---|
| The model cannot move money or set an amount | `src/core/tools.ts`: no tool takes an amount; unknown arguments are dropped. `src/core/gate.ts` computes amounts from order data |
| Only the customer's own orders | `ActionService.lookupOrder` and `ownsOrder`; identity is bound in `src/core/agent.ts`, never taken from the model |
| 30-day window, sale, hygiene, cancellation rules | `src/core/gate.ts` |
| A fault claim must be the customer's words | `isGrounded` in `src/core/gate.ts` |
| Never refund more than was paid on an order | `CHECK` on `ledger_orders` in `src/store/schema.ts` |
| Never action more units than were bought | `CHECK` on `ledger_lines` |
| The same request cannot be live twice | Partial unique index on `actions.idempotency_key`; the key is also passed to the gateway |
| A repeat on a partly actioned item is never silent | `CONFIRM_ADDITIONAL_UNITS` in `src/core/gate.ts` |
| Limits, budget, velocity, risk tier | `src/core/gate.ts`, `src/core/risk.ts`, numbers in `src/config/tenant.ts` |
| A ticket is decided once; approvers have budgets | `decideEscalation` in `src/core/actions.ts` |
| The reply cannot claim what did not happen | `checkOutput` in `src/core/guards.ts` |
| The decision is logged before money moves, and the log cannot be quietly edited | `src/core/audit.ts`; triggers in `src/store/schema.ts` |
| Automation can be switched off | `MONEY_ACTIONS_ENABLED`, read in `src/app.ts` |

The hash chain is per conversation, not global. It shows that a conversation's history was not edited or shortened in the middle. It does not by itself reveal the removal of an entire conversation or of the newest rows; shipping the log to write-once storage would cover that (not implemented).

## Failure modes

| Failure | Behaviour |
|---|---|
| Order system unreachable | No action, fixed honest reply, one P2 ticket |
| Payment gateway rejects | Action `failed`, reservation released, customer told nothing was paid, P1 ticket that an approver can retry |
| Crash between reserve and commit | Action stays `pending` and keeps its reservation; listed by `npm run reconcile` |
| Model unavailable, malformed output, or no final answer | Bounded retries, then a safe reply and a P3 ticket |
| Model claims success it did not have | Output guard replaces the reply |
| Order ships while being cancelled | The order system's status guard refuses; no money moves |
| Stock sells out during an exchange | Inventory constraint refuses; reservation released |
| Two approvers decide at once | One wins; the other is told it was already decided |
| No model key configured | Safe reply and a ticket; no crash |

## Constraints from the Cloudflare free tier

- **D1 has no interactive transactions.** Atomic steps are expressed as one `batch()`, and "abort if a precondition fails" is done with constraints, not with read-then-write.
- **Queries per request are limited** on the free plan (50 per Worker invocation when this was written; check Cloudflare's current limits). So each turn batches its reads (one batch for the gate's facts), loads the customer's orders once per turn, and buffers audit events into one write. A typical turn with three tool calls uses about 20 queries.
- **CPU time per request is small** on the free plan. Waiting on the model or on D1 does not count; the code avoids heavy work in the request path.
- **No background workers are used.** Notifications are written to an outbox in the same request; reconciliation and audit verification are on-demand commands.
