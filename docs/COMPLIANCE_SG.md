# Singapore rules mapped to controls

This is an engineering mapping, **not legal advice**. It records which rules shaped the design and where the code responds to them, so a client's legal team can check it. The IMDA and PDPC frameworks and guidelines listed here are advisory, not binding law. The research was done on 18 November 2026; the statute text was read from a mirror because the official site blocked automated fetching, and items marked *unverified* could not be confirmed from a primary source.

"Not implemented" and "client responsibility" are stated wherever that is the truth.

## Consumer law

| Rule | What it requires | Control in this build | Where |
|---|---|---|---|
| **Lemon Law** (Consumer Protection (Fair Trading) Act, Part 3) | A defect found within 6 months of delivery is presumed to have existed at delivery. The buyer may ask for repair or replacement, then a price reduction or refund. A refund may be reduced for use. Contract terms cannot exclude this, and discounted goods are covered. | A fault claim made within 6 calendar months of delivery is never auto-denied, including for sale and hygiene items and after the 30-day window. It goes to a human queue (`statutory_defect_claim` or `defect_verification`). The prompt tells customers their legal rights are unaffected by the return window. | `src/core/gate.ts`, `src/core/prompt.ts`, `statutoryDefectWindowMonths` in `src/config/tenant.ts` |
| | Remedy choice (repair, replacement, partial refund) | **Not implemented as actions.** The ticket proposes a refund or exchange; the reviewer decides the remedy and handles repair or a reduced refund outside the system. | |
| | Claims after 6 months | Declined by the gate. The customer can ask for a person, who can consider Sale of Goods Act rights. A client may prefer to route these to a human as well. | `src/core/gate.ts` |
| **No general cooling-off right** for ordinary online retail | A 30-day change-of-mind window is voluntary store policy and must be stated as published. A government review panel was due to report by end-2026 with mandatory cooling-off on its agenda. | The window is a versioned config value, and the policy version is stored on every action and gate decision. | `policy.version`, `returnWindowDays` in `src/config/tenant.ts` |
| **Unfair practices** (CPFTA s 4, Second Schedule; paragraph numbers *unverified*) | Do not mislead; do not misrepresent a consumer's rights or remedies; no false price or urgency claims. Acts of agents are attributed to the supplier. | Policy numbers in the prompt are rendered from config, so the prompt and the gate cannot disagree. Eligibility answers come from a dry run of the gate. The output guard blocks claims of completed actions that are not in the ledger and amounts no tool returned. | `src/core/prompt.ts`, `describeOptions` in `src/core/actions.ts`, `src/core/guards.ts` |
| | Limit of the control | The guard is pattern-based. It does not verify every sentence the model writes about policy. | |
| **Sale of Goods Act implied terms; Unfair Contract Terms Act** (secondary sources only) | Implied terms on quality cannot be excluded against consumers. | Covered by the fault-claim route above. | |
| **Electronic Transactions Act 2010, s 16** | A person may withdraw an input error if an automated system gave no chance to correct it. | Ambiguous requests get a clarifying question before anything is done. A mistake can be reported to the agent or a person. **A confirm-before-execute step is not implemented.** | `src/core/prompt.ts` (rule 5) |
| **TR 76 e-commerce guidelines** (industry Technical Reference, paywalled, not read) | Voluntary. | Not assessed. | |

## Personal data (PDPA 2012)

| Obligation | Control in this build | Where |
|---|---|---|
| Consent, purpose, notification (ss 13 to 20) | **Client responsibility.** The client's privacy notice must cover support chat and the use of an AI model. | |
| Access and correction (ss 21, 22) | A personal-data request is a ticket category (`privacy_request`, P2) routed to a person. **No self-service export is implemented.** | `src/core/tools.ts`, `src/core/escalations.ts` |
| Protection (s 24) | Tools return only the current identity's orders. Another customer's order is reported as "not found" and the attempt is logged. Payment methods are stored and shown masked ("Visa ending 4242"). Admin routes need a bearer key. Keys come only from environment variables. | `lookupOrder` in `src/core/actions.ts`, `src/core/guards.ts`, `src/app.ts` |
| Data minimisation toward the model | Card numbers, security codes and NRIC/FIN numbers are removed before storage and before the model call. What **is** sent to the model provider: the customer's name and customer ID or guest email, the chat text, and this customer's order details when a tool is called. | `checkInput` in `src/core/guards.ts`, `src/core/prompt.ts` |
| Transfer overseas (s 26) | The default model provider is outside Singapore. **Client responsibility:** a contract binding the provider to comparable protection, or a provider and region the client has approved. The provider is a configuration choice (`LLM_BASE_URL`). | `src/app.ts` |
| Retention limitation (s 25) | **Not implemented.** There is no retention or anonymisation job. Suggested schedule: audit log and ledger at least 5 years as financial records; chat transcripts for a shorter documented period. | |
| Breach notification (assess within 30 days; notify PDPC within 3 calendar days of deciding it is notifiable) | **Client responsibility.** The audit log supports the investigation. | `src/core/audit.ts` |
| Data protection officer (s 11) | **Client responsibility.** The support contact is a config value. | `src/config/tenant.ts` |
| **NRIC numbers** (PDPC advisory guidelines; deadline of 31 Dec 2026 to stop using NRIC for authentication, from law-firm summaries) | The agent never asks for an NRIC and never authenticates with one. Any NRIC or FIN typed by a customer is redacted. | `src/core/guards.ts` |
| PDPC advisory guidelines on AI systems (2024) and on generative AI (20 Jul 2026) | The deployer limits the agent's data access to its purpose and sends high-risk tasks to people: see the rows above and the approval controls below. | |

## AI governance (advisory)

| Guidance | What it recommends | Control in this build | Where |
|---|---|---|---|
| **IMDA Model AI Governance Framework for Agentic AI** (v1.5, 2026) | Limit the agent's tools, data and autonomy | Seven tools. No tool reaches a payment system, takes an amount, or takes an identity. | `src/core/tools.ts` |
| | Human approval for high-stakes or irreversible actions, including payments | Refunds above the limit, unverified fault claims, high-risk customers, budget overruns and statutory claims need an approver with a budget. Refunds inside the limits **are** executed without a person; that is a deliberate, bounded choice. Setting `MONEY_ACTIONS_ENABLED=false` makes every action need a person. | `src/core/gate.ts`, `decideEscalation` in `src/core/actions.ts` |
| | Enforce approvals in the system, not in the prompt | The gate and the database constraints decide; the prompt is not relied on. | `src/core/gate.ts`, `src/store/schema.ts` |
| | Log and trace every step in immutable logs | Hash-chained, append-only audit log with a verifier. | `src/core/audit.ts` |
| | Distinct identity and least privilege per agent | Each action records whether the agent or a named approver executed it. **Per-agent credentials are not implemented.** | `actions.origin`, `actions.approved_by` |
| | Tell users they are dealing with an agent, what it can do, and how to reach a person | The assistant is instructed to say it is an AI, and can hand over to a person at any time. | `src/core/prompt.ts`, `escalate_to_human` |
| **IMDA Transparency Guidelines for Generative AI Chatbots** (20 Jul 2026) | An "info card" at first use: capabilities, limits, reliability, data handling | The web chat page is where this belongs; check `public/index.html` for what this build shows. Wording for a production card is the client's. | `public/` |

## Tax, payments, records, messaging

| Rule | Control in this build | Where |
|---|---|---|
| **GST** 9%; registered sellers show GST-inclusive prices; a return needs a credit note that reverses GST at the original rate | All prices are treated as GST-inclusive and the prompt says so. A refund returns the gross amount paid. **Credit notes are not implemented**; the action ID and gateway reference are there to link one. | `src/data/seed.ts`, `src/core/prompt.ts` |
| **Refund to the original payment method** (card-scheme norm; no licence needed for a merchant refunding its own customer is an inference, not an MAS statement) | The payment port accepts only the original charge reference. There is no way to name another destination. Store credit is not implemented. | `PaymentPort` in `src/ports/index.ts` |
| **Refund timing** (no statutory timeline found) | Quoted as an estimate, "usually within 5 to 10 business days". | `src/config/tenant.ts` |
| **Record keeping** (5 years for GST, income tax and company records) | The ledger and audit log are append-only and never deleted by the agent. **A retention schedule is not implemented.** | `src/store/schema.ts` |
| **Do Not Call and Spam Control Act** | The agent only replies to messages the customer sends. It sends no proactive or marketing messages. | `src/core/agent.ts` |

## Sources

- Consumer Protection (Fair Trading) Act 2003: https://sso.agc.gov.sg/Act/CPFTA2003
- Competition and Consumer Commission of Singapore, overview of the Act: https://www.ccs.gov.sg/consumer-protection/legislation-and-guidelines/overview-of-the-consumer-protection--fair-trading--act/
- Ministry of Trade and Industry advisory on the amendments: https://mti.gov.sg/resources/laws-and-regulations/general-advisory-on-amendments-to-the-consumer-protection-fair-trading-act-and-hire-purchase-act
- Cancellation of contracts regulations (direct sales and similar): https://sso.agc.gov.sg/SL/CPFTA2003-S65-2009
- Consumer Protection Review Panel announcement: https://www.case.org.sg/wp-content/uploads/2026/03/Media-Release-_Consumer-Protection-Review-Panel-to-seek-publics-views-on-consumer-issues.pdf
- Personal Data Protection Act 2012: https://sso.agc.gov.sg/Act/PDPA2012
- PDPC guide on managing and notifying data breaches: https://www.pdpc.gov.sg/-/media/files/pdpc/pdf-files/other-guides/guide-on-managing-and-notifying-data-breaches-under-the-pdpa-15-mar-2021.pdf
- PDPC advisory guidelines on personal data in generative AI: https://www.pdpc.gov.sg/organisations/regulations-decisions/regulatory-guidance/advisory-guidelines-on-use-of-personal-data-in-generative-ai
- PDPC advisory guidelines on AI recommendation and decision systems: https://www.pdpc.gov.sg/-/media/files/pdpc/pdf-files/advisory-guidelines/advisory-guidelines-on-the-use-of-personal-data-in-ai-recommendation-and-decision-systems.pdf
- PDPC announcement on NRIC numbers: https://www.pdpc.gov.sg/news-and-events/announcements/2026/01/pdpc-to-step-up-enforcement-action-against-misuse-of-nric-numbers-and-issues-new-advisory-on-data-protection
- PDPC retention limitation obligation: https://www.pdpc.gov.sg/-/media/files/pdpc/pdf-files/advisory-guidelines/the-retention-limitation-obligation---ch-18-(270717).pdf
- IMDA Model AI Governance Framework for Agentic AI: https://www.imda.gov.sg/assets/d1e45a56-d898-4b9f-972e-8ae94be1a5a5.pdf
- IMDA Transparency Guidelines for Generative AI Chatbots: https://www.imda.gov.sg/-/media/imda/file/emerging-technologies-and-research/artificial-intelligence/transparency-guidelines-for-generative-ai-chatbots.pdf
- Launch announcement for the agentic framework: https://www.mddi.gov.sg/newsroom/singapore-launches-new-model-ai-governance-framework-for-agentic-ai--/
- IRAS, displaying and quoting prices: https://www.iras.gov.sg/taxes/goods-services-tax-(gst)/basics-of-gst/invoicing-price-display-and-record-keeping/displaying-and-quoting-prices
- IRAS, invoicing customers: https://www.iras.gov.sg/taxes/goods-services-tax-(gst)/basics-of-gst/invoicing-price-display-and-record-keeping/invoicing-customers
- IRAS, keeping records: https://www.iras.gov.sg/taxes/goods-services-tax-(gst)/basics-of-gst/invoicing-price-display-and-record-keeping/keeping-records
- Payment Services Act 2019: https://sso.agc.gov.sg/Act/PSA2019
- MAS FAQs on the Payment Services Act: https://www.mas.gov.sg/-/media/mas-media-library/regulation/faqs/pd/faqs-on-payment-services-act-2019/payment-services-act-faq--19-april-2024.pdf
- Electronic Transactions Act 2010: https://sso.agc.gov.sg/Act/ETA2010
- Do Not Call registry for businesses: https://www.pdpc.gov.sg/overview-of-pdpa/do-not-call-registry/business-owner/do-not-call-registry-and-your-business
- Spam Control Act 2007: https://sso.agc.gov.sg/Act/SCA2007
- Enhanced e-commerce guidelines (TR 76): https://www.ccs.gov.sg/media-and-events/newsroom/announcements-and-media-releases/enhanced-e-commerce-guidelines-to-safeguard-consumer-trust-and-foster-competitive-e-commerce-market/
