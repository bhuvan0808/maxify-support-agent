/**
 * Composition root: the one place where ports are bound to adapters.
 *
 * `createApp` is used by every entry point (CLI, Worker, evals, tests), so they all
 * run exactly the same agent. To integrate a client's stack, replace an adapter here:
 *
 *   commerce  -> their commerce platform / OMS          (implements CommercePort)
 *   payments  -> their payment gateway                   (implements PaymentPort)
 *   notifier  -> their helpdesk / pager / chat webhook   (implements NotifierPort)
 *   llm       -> their model provider                    (implements LlmPort)
 *   sql       -> D1, SQLite, or any SQL store            (implements SqlDriver)
 *
 * Configuration comes only from environment variables (never from code or the repo).
 * This module imports nothing Node-specific, so it bundles for Cloudflare Workers.
 */

import { OpenAiCompatibleLlm } from "./adapters/llm/openaiCompatible.ts";
import { LocalCommerce } from "./adapters/commerce/local.ts";
import { OutboxNotifier } from "./adapters/notify/outbox.ts";
import { MockPaymentGateway } from "./adapters/payments/mock.ts";
import { defaultTenant, type TenantConfig } from "./config/tenant.ts";
import { ActionService } from "./core/actions.ts";
import { SupportAgent } from "./core/agent.ts";
import { EscalationService } from "./core/escalations.ts";
import { isTruthyFlag, safeJsonParse } from "./core/util.ts";
import type { Clock, CommercePort, LlmPort, Notification, PaymentPort, SqlDriver } from "./ports/index.ts";
import { LlmUnavailable } from "./ports/index.ts";

export type Env = Record<string, string | undefined>;

export interface AppOptions {
  sql: SqlDriver;
  env: Env;
  cfg?: TenantConfig;
  clock?: Clock;
  /** Overrides the model built from the environment (evals pass a scripted model). */
  llm?: LlmPort;
  commerce?: CommercePort;
  payments?: PaymentPort;
  onNotify?: (notification: Notification) => void;
  enforceRateLimit?: boolean;
  newTraceId?: () => string;
  /** Per-request fault injection, in addition to the environment flags. */
  faults?: { orderLookupFail?: boolean; paymentFail?: boolean };
  /** Longest wait between model retries. */
  llmMaxRetryWaitMs?: number;
}

export interface App {
  agent: SupportAgent;
  actions: ActionService;
  escalations: EscalationService;
  commerce: CommercePort;
  payments: PaymentPort;
  sql: SqlDriver;
  cfg: TenantConfig;
  clock: Clock;
  llmLabel: string;
}

/** The real clock, or a fixed instant when AGENT_NOW is set (used to make evals repeatable). */
export function clockFromEnv(env: Env): Clock {
  const fixed = env.AGENT_NOW ? new Date(env.AGENT_NOW) : null;
  if (fixed && !Number.isNaN(fixed.getTime())) return { now: () => new Date(fixed.getTime()) };
  return { now: () => new Date() };
}

/** Which API key variable is in use, without exposing its value. */
export function apiKeyFromEnv(env: Env): { key: string | undefined; source: string | null } {
  const candidates = ["LLM_API_KEY", "GROQ_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"];
  for (const name of candidates) {
    const value = env[name]?.trim();
    if (value) return { key: value, source: name };
  }
  return { key: undefined, source: null };
}

/** A model that explains what is missing instead of crashing at start-up. */
class MissingKeyLlm implements LlmPort {
  readonly label = "unconfigured";
  async complete(): Promise<never> {
    throw new LlmUnavailable(
      "No model API key is configured. Set LLM_API_KEY (or GROQ_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY) in the environment.",
    );
  }
}

export function llmFromEnv(env: Env, options: { maxRetryWaitMs?: number } = {}): LlmPort {
  const { key } = apiKeyFromEnv(env);
  if (!key) return new MissingKeyLlm();
  const model = env.LLM_MODEL?.trim() || "openai/gpt-oss-120b";
  // Reasoning models spend output tokens on hidden reasoning; keep that small for a chat agent
  // unless the operator overrides it with LLM_EXTRA_BODY.
  const extraBody =
    safeJsonParse<Record<string, unknown> | undefined>(env.LLM_EXTRA_BODY, undefined) ??
    (/gpt-oss/i.test(model) ? { reasoning_effort: "low" } : undefined);

  // Any OpenAI-compatible chat-completions endpoint works: set LLM_BASE_URL and LLM_MODEL.
  return new OpenAiCompatibleLlm({
    apiKey: key,
    baseUrl: env.LLM_BASE_URL?.trim() || "https://api.groq.com/openai/v1",
    model,
    maxRetryWaitMs: options.maxRetryWaitMs,
    fallbackModel: env.LLM_FALLBACK_MODEL?.trim() || (/gpt-oss-120b/i.test(model) ? "openai/gpt-oss-20b" : undefined),
    extraBody,
  });
}

export function createApp(options: AppOptions): App {
  const { sql, env } = options;
  const cfg = options.cfg ?? defaultTenant;
  const clock = options.clock ?? clockFromEnv(env);
  const newTraceId = options.newTraceId ?? (() => crypto.randomUUID());

  const commerce =
    options.commerce ??
    new LocalCommerce(sql, clock, {
      // Documented fault injection: ORDER_LOOKUP_FAIL=1 makes every order lookup fail.
      orderLookupFails: () => isTruthyFlag(env.ORDER_LOOKUP_FAIL) || options.faults?.orderLookupFail === true,
    });
  const payments =
    options.payments ??
    new MockPaymentGateway(sql, clock, {
      paymentFails: () => isTruthyFlag(env.PAYMENT_FAIL) || options.faults?.paymentFail === true,
    });
  const notifier = new OutboxNotifier(sql, clock, {
    webhookUrl: env.NOTIFY_WEBHOOK_URL?.trim() || undefined,
    onNotify: options.onNotify,
  });
  const llm = options.llm ?? llmFromEnv(env, { maxRetryWaitMs: options.llmMaxRetryWaitMs });

  const escalations = new EscalationService(sql, clock, cfg, notifier);
  const actions = new ActionService({
    sql,
    commerce,
    payments,
    clock,
    cfg,
    escalations,
    // Kill switch: anything other than an explicit "false"/"0"/"off" leaves automation on.
    moneyActionsEnabled: () => !["false", "0", "off", "no"].includes((env.MONEY_ACTIONS_ENABLED ?? "true").trim().toLowerCase()),
    newTraceId,
  });
  const agent = new SupportAgent({
    sql,
    commerce,
    llm,
    clock,
    cfg,
    actions,
    escalations,
    newTraceId,
    enforceRateLimit: options.enforceRateLimit ?? false,
  });

  return { agent, actions, escalations, commerce, payments, sql, cfg, clock, llmLabel: llm.label };
}
