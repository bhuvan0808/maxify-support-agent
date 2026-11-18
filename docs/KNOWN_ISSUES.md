# Known issues and failure log

An honest record of what failed during the build, what was done about it, and what was
left as it is and why. Times are 18 Nov 2026 (Singapore).

## Fixed

| # | What failed | Evidence | Cause | Fix |
|---|---|---|---|---|
| 1 | Every model call failed with `404 model_not_found`; the customer got the safe fallback reply and a ticket. | Audit log event `model_failure` on the first CLI runs. | The template default `llama-3.3-70b-versatile` is not available to this Groq account. | Default model changed to `openai/gpt-oss-120b` (`src/app.ts`, `.env.example`). |
| 2 | A repeated refund request was answered correctly ("already refunded, reference ACT-000001") but the structured result did not flag it, so the CLI printed only `ACTION: none`. | Manual CLI test; also reported by the deploy smoke test. | The model recognised the repeat from the customer's history and did not call the request tool again, so the gate never saw a duplicate. | The agent now reports an earlier action as recognised when nothing new was done and the reply cites its reference (`src/core/agent.ts`). A repeat that does reach the gate was always refused there. |
| 3 | Replies contained typographic hyphens (`ORD‑1001`), which the output guard's order-number check would not recognise. | Manual CLI test. | Model output style. | Replies are normalised to plain hyphens and spaces before the guard runs (`src/core/agent.ts`). |

## Mitigated, not eliminated

**Model rate limit on the free Groq tier.** The account allows 8,000 tokens per minute
on `openai/gpt-oss-120b`. One model call here is about 1,800 tokens and a turn needs two
or three, so three or four messages inside a minute exhaust it and Groq answers `429`.

- Observed: manual test, sale-item request for C002, audit event `model_failure`
  ("Rate limit reached ... Limit 8000, Used 7724, Requested 2076").
- What the customer saw: "I'm sorry, I ran into a problem and couldn't complete that.
  Nothing has been changed on your orders. I've asked a team member to pick this up
  (reference ESC-...)". No money moved; a P3 ticket was raised. It fails safe.
- Mitigation now in place (`src/adapters/llm/openaiCompatible.ts`): wait up to 20 seconds
  honouring `retry-after`, then finish the request on a second model
  (`openai/gpt-oss-20b`, separate quota). If both are limited the safe reply above is used.
- Why it is left: it is a property of the free plan, not of the code. A paid key removes
  it. The live eval suite and the deployed demo share the same quota, so a live eval run
  and manual testing at the same moment will collide.

## Not done, and why

| Item | Reason |
|---|---|
| Native Anthropic model adapter | Dropped for time. Any OpenAI-compatible endpoint works through `LLM_BASE_URL` / `LLM_MODEL`. |
| Vendor-specific helpdesk adapters (Zendesk, Intercom, Freshdesk, WhatsApp) | Not built. The channel-neutral `POST /v1/chat` API and the notification webhook are the integration points; see `docs/INTEGRATION.md`. |
| Confirm-before-execute step | Not built. Explicit requests execute at once; ambiguous ones are clarified. See `ASSUMPTIONS.md`. |
| Refund released on return scan | Not built. Refunds are issued at once with a return label; risk limits and human review bound the exposure. |
| Approver single sign-on, four-eyes approval | Not built. Approvers are a static list with per-role limits in `src/config/tenant.ts`. |
| Data-retention jobs | Not built. Retention periods are a client decision; see `docs/COMPLIANCE_SG.md`. |
| Vercel deployment | Not used. The service targets Cloudflare Workers and D1, which the free tier covers. |

## Not verified

- The web chat and ops console pages return HTTP 200 and every API they call was
  exercised, but nobody clicked through them in a browser before submission.
- The payment-failure fault was not triggered against the live URL. It is covered by the
  deterministic eval case `payment-gateway-failure`.
- The model fallback path (second model after a long rate limit) was added after the
  failure above and has not been observed firing.
