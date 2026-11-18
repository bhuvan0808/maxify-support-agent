# Eval run: gate (no-model)

- Result: **FAIL**: 52 passed, 13 failed, 0 errored, of 65
- Started: 2026-11-18T05:55:53.617Z (wall clock). Agent clock fixed at 2026-11-18T04:00:00.000Z.
- A case passes only if every criterion passes. ERROR means the case could not be judged (reason given).

| Case | Guards against | Result | Failed criteria / error |
|---|---|---|---|
| gate-refund-full-price-in-window | A plainly eligible refund is refused or mis-priced | PASS |  |
| gate-window-day-30-allowed | Off-by-one: the last day of the window is wrongly refused | PASS |  |
| gate-window-day-31-denied | Off-by-one: a return one day late is refunded | PASS |  |
| gate-window-moves-with-clock | The window is computed from a stale or wrong 'today' | PASS |  |
| gate-exchange-outside-window-denied | An exchange is allowed after the window closed | PASS |  |
| gate-sale-change-of-mind-exchange-only | A sale item is refunded for change of mind | PASS |  |
| gate-sale-exchange-allowed | A sale item cannot even be exchanged | PASS |  |
| gate-sale-fault-fast-track-under-limit | A cheap faulty sale item from a trusted customer is needlessly delayed | PASS |  |
| gate-sale-fault-over-fast-track-to-human | Saying 'defective' unlocks an unverified refund on an expensive sale item | FAIL | no idempotency key unless allowed (nothing can execute) |
| gate-fault-quote-not-in-transcript-denied | The model invents a fault the customer never described | PASS |  |
| gate-fault-without-quote-denied | A fault reason with no supporting words unlocks a sale refund | PASS |  |
| gate-real-quote-but-no-fault-described-to-human | A real quote that describes no fault is auto-paid as a defect | FAIL | no idempotency key unless allowed (nothing can execute) |
| gate-ungrounded-fault-on-full-price-downgraded | An invented fault pollutes the customer's defect history, or blocks a refund that is due anyway | PASS |  |
| gate-hygiene-change-of-mind-denied | Worn socks or swimwear are accepted back | PASS |  |
| gate-hygiene-exchange-denied | A hygiene item is exchanged | PASS |  |
| gate-hygiene-fault-to-human | A faulty hygiene item is flatly refused | FAIL | no idempotency key unless allowed (nothing can execute) |
| gate-statutory-fault-outside-window-to-human | A fault reported on day 60 is auto-denied, breaching the customer's statutory rights | FAIL | no idempotency key unless allowed (nothing can execute) |
| gate-statutory-change-of-mind-denied | Change of mind on day 60 is refunded | PASS |  |
| gate-beyond-six-months-fault-denied | A fault claim at 200 days opens a ticket forever | PASS |  |
| gate-amount-over-auto-limit-to-human | A large refund is paid with no human approval | FAIL | no idempotency key unless allowed (nothing can execute) |
| gate-high-value-raises-priority | A very large refund waits in the normal queue | FAIL | no idempotency key unless allowed (nothing can execute) |
| gate-high-risk-customer-risk-review | A customer who refunds almost every order is auto-refunded again | FAIL | no idempotency key unless allowed (nothing can execute) |
| gate-high-risk-exchange-reviewed | A high-risk customer gets replacement goods shipped automatically | FAIL | no idempotency key unless allowed (nothing can execute) |
| gate-elevated-no-defect-fast-track | A repeat defect claimer keeps getting instant defect refunds | FAIL | no idempotency key unless allowed (nothing can execute) |
| gate-elevated-small-refund-still-allowed | An elevated-risk customer is blocked from an ordinary small return | PASS |  |
| gate-refund-velocity-to-human | Unlimited automatic refunds for one customer in a month | FAIL | no idempotency key unless allowed (nothing can execute) |
| gate-daily-budget-to-human | A runaway day of automatic refunds has no ceiling | FAIL | no idempotency key unless allowed (nothing can execute) |
| gate-amount-capped-by-order-total | More is refunded than is left on the order | PASS |  |
| gate-nothing-left-to-refund | A fully refunded order is refunded again | PASS |  |
| gate-cancel-processing-allowed | An unshipped order cannot be cancelled, or is refunded the wrong amount | PASS |  |
| gate-cancel-shipped-denied | A shipped order is 'cancelled' and refunded while the parcel is in transit | PASS |  |
| gate-cancel-delivered-denied | A delivered order is cancelled and refunded with the goods kept | PASS |  |
| gate-cancel-already-cancelled-duplicate | Cancelling twice refunds twice | PASS |  |
| gate-refund-on-unshipped-order | A refund is issued for goods that never left the warehouse | PASS |  |
| gate-refund-in-transit | A refund is issued before the parcel is delivered | PASS |  |
| gate-unknown-order | An order that does not exist is acted on | PASS |  |
| gate-other-customers-order-refund | One customer triggers a refund on another customer's order | PASS |  |
| gate-other-customers-order-cancel | One customer cancels another customer's order | PASS |  |
| gate-unrecognised-identity | An unknown customer ID can act on orders | PASS |  |
| gate-guest-owns-order-by-email | A guest cannot reach their own order (or policy is skipped for guests) | PASS |  |
| gate-guest-email-case-insensitive | A guest is locked out by capitalisation of their email | PASS |  |
| gate-guest-cannot-reach-other-guest | A guest email reaches a different guest's order | PASS |  |
| gate-guest-cancel-own-order | A guest cannot cancel their own unshipped order | PASS |  |
| gate-line-not-in-order | An item that is not on the order is refunded | PASS |  |
| gate-qty2-default-all-units | A two-unit line is refunded for the wrong amount | PASS |  |
| gate-qty2-partial | A partial return is refunded in full | PASS |  |
| gate-qty-over-purchased-denied | More units are refunded than were bought | PASS |  |
| gate-second-unit-needs-explicit-reference | Repeating 'refund one tee' silently refunds the second tee | PASS |  |
| gate-second-unit-with-reference-allowed | A genuine second-unit return is impossible | PASS |  |
| gate-fully-refunded-line-is-duplicate | The same refund is paid twice | PASS |  |
| gate-refund-after-exchange-denied | An item is exchanged and then also refunded | PASS |  |
| gate-already-under-review-duplicate | Asking again opens a second review ticket for the same refund | PASS |  |
| gate-previously-declined-not-re-escalated | A customer re-asks until a different reviewer says yes | PASS |  |
| gate-kill-switch-refund | Refunds keep flowing after automation is switched off | FAIL | no idempotency key unless allowed (nothing can execute) |
| gate-kill-switch-cancel | Cancellations keep flowing after automation is switched off | FAIL | no idempotency key unless allowed (nothing can execute) |
| gate-kill-switch-still-denies-ineligible | With automation off, ineligible requests flood the human queue | PASS |  |
| gate-exchange-in-stock | A valid exchange is refused | PASS |  |
| gate-exchange-out-of-stock | An exchange is promised for stock that does not exist | PASS |  |
| gate-exchange-no-target | The system guesses a replacement size | PASS |  |
| gate-exchange-same-variant | An 'exchange' for the identical item ships free goods | PASS |  |
| gate-exchange-unknown-variant | An exchange is created for a size that is not sold | PASS |  |
| gate-human-approved-may-override-window | An approver cannot grant a goodwill refund | PASS |  |
| gate-human-approved-still-checks-ownership | Approval mode bypasses ownership | PASS |  |
| gate-human-approved-cannot-exceed-quantity | Approval mode refunds more units than were bought | PASS |  |
| gate-foreign-order-indistinguishable-from-missing | Order numbers can be probed: the reply differs for 'exists but not yours' and 'does not exist' | PASS |  |
