/**
 * LlmPort for any OpenAI-compatible chat-completions endpoint with tool calling:
 * Groq, OpenAI, OpenRouter, Together, Mistral, Azure OpenAI, a local Ollama, and others.
 * Plain `fetch`, no SDK, so the same code runs on Node and on Cloudflare Workers.
 *
 * Robustness:
 *   - request timeout;
 *   - bounded retries on 429 / 5xx / network errors, honouring `retry-after`;
 *   - one retry when the provider reports a malformed tool call from the model;
 *   - if the provider rejects an optional parameter (seed, temperature, max_tokens...),
 *     that parameter is dropped and the request retried, so a client can point this at
 *     a different model without code changes.
 */

import type { LlmMessage, LlmPort, LlmRequest, LlmResponse, ToolCall } from "../../ports/index.ts";
import { LlmUnavailable } from "../../ports/index.ts";

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Longest single wait between retries. Evals raise this to ride out free-tier rate limits. */
  maxRetryWaitMs?: number;
  seed?: number;
  /**
   * A second model on the same endpoint, used for the rest of a request when the primary
   * is rate-limited for longer than we are willing to keep a customer waiting. Providers
   * meter each model separately, so this roughly doubles headroom on small plans.
   */
  fallbackModel?: string;
  /** Extra provider-specific body fields, e.g. {"reasoning_effort":"low"}. */
  extraBody?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const OPTIONAL_PARAMS = ["seed", "temperature", "max_tokens", "max_completion_tokens", "tool_choice", "parallel_tool_calls", "reasoning_effort"];

function toWire(message: LlmMessage): Record<string, unknown> {
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content ?? "",
      tool_calls: message.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.arguments },
      })),
    };
  }
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content ?? "" };
  }
  return { role: message.role, content: message.content ?? "" };
}

/** Some models wrap private reasoning in <think> tags inside the content. Never show that to a customer. */
function stripReasoning(content: string | null | undefined): string | null {
  if (!content) return null;
  const cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/i, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

export class OpenAiCompatibleLlm implements LlmPort {
  readonly label: string;
  private readonly dropped = new Set<string>();
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    let host = "llm";
    try {
      host = new URL(options.baseUrl).hostname.replace(/^api\./, "");
    } catch {
      // Keep the generic label if the base URL is not a valid URL; the request will fail clearly later.
    }
    this.label = `${host}:${options.model}`;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private body(request: LlmRequest, temperature: number, model: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      messages: request.messages.map(toWire),
      temperature,
      max_tokens: request.maxTokens,
      seed: this.options.seed ?? 7,
      ...(this.options.extraBody ?? {}),
    };
    if (request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = "auto";
    }
    if (this.dropped.has("max_tokens") && !this.dropped.has("max_completion_tokens")) {
      body.max_completion_tokens = request.maxTokens;
    }
    for (const param of this.dropped) delete body[param];
    return body;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const maxRetries = this.options.maxRetries ?? 3;
    const maxWait = this.options.maxRetryWaitMs ?? 20_000;
    let model = this.options.model;
    let transientAttempts = 0;
    let malformedToolRetries = 0;
    let adaptations = 0;
    let temperature = 0;

    for (;;) {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` },
          body: JSON.stringify(this.body(request, temperature, model)),
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
        });
      } catch (err) {
        if (transientAttempts++ < maxRetries) {
          await this.sleep(Math.min(maxWait, 1000 * 2 ** (transientAttempts - 1)));
          continue;
        }
        throw new LlmUnavailable(`Model request failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (response.ok) {
        const data = (await response.json()) as {
          model?: string;
          choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const message = data.choices?.[0]?.message;
        if (!message) throw new LlmUnavailable("Model returned no message");
        const toolCalls: ToolCall[] = (message.tool_calls ?? [])
          .filter((c) => c.function?.name)
          .map((c, index) => ({
            id: c.id ?? `call_${index}`,
            name: c.function!.name!,
            arguments: c.function!.arguments ?? "{}",
          }));
        return {
          content: stripReasoning(message.content),
          toolCalls,
          model: data.model ?? model,
          usage: data.usage
            ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 }
            : null,
        };
      }

      const text = await response.text().catch(() => "");
      const status = response.status;

      if (status === 429 || status >= 500) {
        if (transientAttempts++ < maxRetries) {
          const retryAfter = Number(response.headers.get("retry-after"));
          const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 + 250 : 1000 * 2 ** (transientAttempts - 1);
          if (wait <= maxWait) {
            await this.sleep(wait);
            continue;
          }
        }
        // Rate-limited for too long on the primary model: finish this request on the fallback.
        if (status === 429 && this.options.fallbackModel && model !== this.options.fallbackModel) {
          model = this.options.fallbackModel;
          transientAttempts = 0;
          continue;
        }
        throw new LlmUnavailable(`Model provider returned ${status}: ${text.slice(0, 300)}`, status);
      }

      if (status === 400) {
        // The model emitted a tool call the provider could not parse. A second sample usually succeeds.
        if (/tool_use_failed|failed to call a function|failed_generation/i.test(text) && malformedToolRetries++ < 1) {
          temperature = 0.2;
          continue;
        }
        // The provider or model does not support an optional parameter: drop it and retry.
        const unsupported = OPTIONAL_PARAMS.find((p) => !this.dropped.has(p) && new RegExp(`\\b${p}\\b`).test(text));
        if (unsupported && adaptations++ < OPTIONAL_PARAMS.length) {
          this.dropped.add(unsupported);
          continue;
        }
      }
      throw new LlmUnavailable(`Model provider returned ${status}: ${text.slice(0, 300)}`, status);
    }
  }
}
