# Assumptions and decisions

The brief fixes two policies: (a) returns within 30 days of delivery, and (b) sale items are exchange-only, except defective sale items, which can be refunded. Everything else below was left open and decided here.

Each entry gives what was open, what was decided, and why. All numbers live in [src/config/tenant.ts](src/config/tenant.ts) and can be changed per client without touching logic. The first market is Singapore; the legal background is in [docs/COMPLIANCE_SG.md](docs/COMPLIANCE_SG.md).

## The return window

1. **How 30 days is counted.** Calendar days in the store's time zone (Asia/Singapore). The delivery day is day 0, and a request on day 30 is allowed; day 31 is not. *Why:* customers think in dates, not hours, and a calendar-day rule gives the same answer at 9am and 11pm.
2. **Exchanges use the same window.** An exchange must also be requested within 30 days of delivery. *Why:* policy (a) reads as the general return window, and an unlimited exchange window on sale items would be an obvious gap.
3. **Orders not yet delivered cannot be returned.** A shipped order must arrive first; an unshipped one is cancelled instead. *Why:* there is nothing to return yet.

## What counts as a sale item, and how much is refunded

4. **Sale status is fixed at purchase.** Each order line records whether that unit was bought at a sale price. Today's catalogue is ignored. *Why:* a product going on sale after purchase must not turn a refundable item into an exchange-only one, or the reverse.
5. **Refund amount.** Price actually paid per unit times units returned, capped by what is left unrefunded on the order. The model never supplies an amount. *Why:* the amount is the thing an attacker most wants to control.
6. **Shipping fees.** Refunded only when a whole order is cancelled before shipping. Not refunded on a return. *Why:* the service was delivered. A reviewer handling a fault claim can decide otherwise.
7. **Prices include GST.** All seeded prices are GST-inclusive and refunds return the gross amount paid. Credit notes are the client finance system's job (not implemented).
8. **Refund destination and timing.** Only the original payment method, and "usually within 5 to 10 business days" is quoted as an estimate. *Why:* the payment port has no parameter for any other destination.
9. **Instant refund with a return label.** An approved refund is paid immediately and the customer is told a prepaid label has been emailed and to send the item back within 14 days. Sending the label and chasing unreturned items are outside this build. **Not implemented:** releasing the refund only when the return parcel is scanned. *Why:* the brief asks for an agent that issues refunds; the risk is bounded by the limits and risk tiers below.

## Exchanges

10. **What can be exchanged for what.** Another size and/or colour of the same product, same quantity, subject to stock. No price difference arises. Swapping for a different product is not automated. *Why:* same-product swaps move no money.
11. **Out of stock.** The request is declined and the in-stock variants are listed; for a full-price item inside the window a refund is offered instead.

## Hygiene items

12. **Socks, underwear and swimwear are not returnable or exchangeable unless faulty.** *Why:* standard apparel practice, and it gives the policy a realistic third category. A fault claim on one goes to a human.

## Fault claims

13. **Which reasons count as a fault.** Defective or damaged, wrong item received, not as described.
14. **A fault must be in the customer's own words.** The model must pass a quote, and code checks it against what the customer actually typed in the conversation. If the quote is not theirs and the claim would change the outcome, the request is declined and the customer is asked what is wrong. If the claim would not change the outcome (a full-price item inside the window), the request proceeds with the reason recorded as "other". *Why:* "defective" is the word that unlocks a refund on a sale item, so the model must not be able to supply it by itself.
15. **A claimed fault is not a verified fault.** Fault claims that unlock money go to a human (queue `defect_verification`, priority P2), who may ask for a photo. The customer is told this and given a reference and a reply time.
16. **Low-value fast track.** A faulty sale item is refunded without a human only when all of these hold: the amount is S$40 or less, the customer is low risk, they have no defect refund in the past 180 days, and their message contains a recognisable description of a fault. Setting `defectFastTrackLimitCents` to 0 turns this off. *Why:* a good customer with a cheap faulty item should not wait a day; the exposure is small and capped.
17. **Faults reported after 30 days but within 6 months go to a human, never an automatic no.** Queue `statutory_defect_claim`. This applies to sale items too. *Why:* Singapore's Lemon Law presumes a defect found within 6 months existed at delivery, and store policy cannot exclude that. The remedy (repair, replacement, partial or full refund) is the reviewer's decision.
18. **After 6 months the request is declined.** The customer can still ask for a person. A client that wants these reviewed too can change one branch in the gate.

## Cancellations

19. **Only before shipping.** An order in `processing` is cancelled with a full refund including shipping. Once shipped it cannot be cancelled; the customer is pointed to a return after delivery.
20. **Whole order only.** Cancelling single lines of an order is not automated; the model hands that over to a person.
21. **Cancellations skip the refund limit and risk review.** *Why:* the goods never left the warehouse, so there is nothing to lose. The kill switch still applies.

## Limits and human approval

22. **Auto-refund limit: S$200 per refund.** Above it, a ticket is raised (`refund_review`); at S$500 or more it is P1.
23. **Daily budget: S$2,000 of automatic refunds per calendar day across all customers.** Beyond it, refunds go to a human as P1 (`budget_exceeded`). *Why:* a ceiling on the damage any undiscovered bug or abuse wave can do in a day.
24. **Velocity: 3 automatic refunds per customer in 30 days**, then a human reviews.
25. **Approver budgets.** Support agent S$300, supervisor S$1,500, finance manager effectively unlimited. An approval above the approver's budget is refused and the ticket stays open. Approvers are a list in config for the demo. **Not implemented:** single sign-on, and two-person approval for very large refunds.
26. **Priorities and reply times.** P1 one hour, P2 eight hours, P3 twenty-four hours. Priority is set by code from the ticket category, never by the model. Safety, legal or chargeback threats, payment disputes, payment failures and budget alerts are P1.
27. **Kill switch.** `MONEY_ACTIONS_ENABLED=false` sends every refund, exchange and cancellation to a human.

## Customer risk

28. **Three tiers, computed from history on every decision.**
    - *Elevated:* 3 or more delivered orders with at least half refunded, or 2 defect refunds in 180 days, or one attempt on someone else's order in 30 days. Effect: the auto-refund limit is halved to S$100 and the fast track is off.
    - *High:* 4 or more delivered orders with at least 75% refunded, or 3 defect refunds in 180 days, or 2 attempts on someone else's orders. Effect: every refund and exchange goes to a human (`risk_review`), with the signals attached.
29. **The customer is never told, and neither is the model.** Tool results carry only "needs a team review". The output guard blocks internal vocabulary. *Why:* the customer who returns a lot may be entirely honest; they should get the same courteous answer and a prompt human decision, not an accusation.

## Identity

30. **Identity comes from the channel and is trusted.** The CLI flag, API field or helpdesk supplies a customer ID or guest email that the channel has already authenticated. No tool accepts an identity from the model, so nothing typed in the chat can change who the customer is. **Not implemented:** one-time-code verification of guest emails; a client should add it in the channel before money actions.
31. **Guests are identified by checkout email.** If the email belongs to a registered customer, the conversation is treated as that customer's.
32. **Unknown customer IDs** can still ask general questions about products and policy. Order tools return nothing and the gate refuses every action.
33. **Someone else's order looks exactly like a missing order.** Same reply either way, so order numbers cannot be probed. The attempt is recorded and counts toward risk.

## Conversation behaviour

34. **Explicit requests are executed without an extra "are you sure?".** If the order, the item and the reason are clear, the request goes to the gate at once. If anything is ambiguous (which order, which item, which size, what is wrong), the agent asks one question first. *Why:* the brief's test is one message in, action out. Singapore's Electronic Transactions Act lets a person withdraw an input error when a system gave no chance to correct it; here the correction path is to tell the agent or a person. **Not implemented:** a confirm-before-execute mode.
35. **Repeat requests.** A repeated refund, exchange or cancellation returns the existing reference and does nothing new. The check is on order, item and action, not on wording.
36. **Further units of the same item.** If one of two units was refunded and the customer asks again, the gate refuses until the request names the earlier action, which the model is told to do only when the customer clearly wants the second unit returned. *Why:* a plain repeat must never quietly pay out a second time.
37. **No second review after a human says no.** If a reviewer rejected a refund or exchange for an item, asking again is declined with the earlier reference. The customer can raise a complaint, which reaches a person.
38. **One open ticket per customer, order, item and category.** Repeats return the existing ticket.

## Failures

39. **Order system down.** Nothing is guessed and nothing is changed. The reply says so in fixed wording, and one ticket is opened (`system_unavailable`, P2).
40. **Payment gateway fails.** The action is marked failed, the reservation is released, the customer is told no money has moved, and a P1 ticket is raised that an approver can use to retry. The same idempotency key is reused, so a retry cannot pay twice.
41. **Model fails or never finishes.** After bounded retries and at most 6 model round-trips and 8 tool calls per message, the customer gets a safe reply and a P3 ticket.
42. **Crash mid-execution.** The action stays `pending` and keeps its reservation; `npm run reconcile` lists it for a human. The failure mode is "a person must look", not "paid twice".

## Guardrails

43. **The model is untrusted.** It can read this customer's data and propose. It cannot decide eligibility, set amounts, choose a priority, reach another customer's data, or call a payment system. Safety does not depend on the prompt.
44. **Output guard.** Before a reply is sent, code checks that it does not claim a refund, exchange or cancellation that is not in the ledger, quote an amount no tool returned, mention an order number the customer does not own or did not type, include another email address, or leak internal terms. A failing reply is replaced by one built from the gate's own wording. The check is pattern-based: it catches the common phrasings, not every possible sentence.
45. **Prompt injection is detected and logged, not blocked.** *Why:* blocking on phrasing is easy to evade and catches real customers; the gate is what makes injection harmless.
46. **Card numbers, card security codes and NRIC/FIN numbers are removed** from a message before it is stored or sent to the model. The agent never asks for them.
47. **Messages are capped at 2,000 characters** and control characters are stripped.

## Data and repeatability

48. **Seed dates are relative.** Orders are stored as "delivered N days ago" and turned into timestamps when the database is seeded, so the boundary cases stay true on whatever day the agent is first run. They age in real time after that; `npm run reset` re-seeds.
49. **Evals use a fixed clock and a fresh in-memory database per scenario**, so results do not depend on the day they run.
50. **IDs are sequential** (`ACT-000001`, `ESC-000001`). *Why:* readable in an audit and identical from run to run.
51. **Assumed store details** that the brief does not give: standard shipping S$5, free from S$80, delivery in 2 to 4 working days within Singapore.

## Deliberately not built

- A native Anthropic adapter. It was planned and dropped for time. Anthropic's OpenAI-compatible endpoint can be tried through `LLM_BASE_URL`; this is untested.
- Vendor-specific helpdesk adapters (Zendesk, Intercom, Freshdesk, WhatsApp). The API is channel-neutral; see [docs/INTEGRATION.md](docs/INTEGRATION.md).
- Single sign-on for approvers, and two-person approval.
- Refund on return receipt, return-label generation, and chasing unreturned items.
- Confirm-before-execute mode.
- Retention and anonymisation jobs for transcripts and the audit log.
- Repair and price reduction as automated remedies; a reviewer handles those outside the system.
- One-time-code verification for guests.
- Signing of the outbound notification webhook.
