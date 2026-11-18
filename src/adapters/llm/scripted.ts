/**
 * A scripted stand-in for the model, used by the evals and unit tests.
 *
 * It replays a fixed list of responses, so a scenario can make the "model" do anything:
 * behave well, call the wrong tool, invent a fault, target another customer's order,
 * repeat a refund three times, or claim success without acting. Because it is fully
 * deterministic and needs no API key, these scenarios are exactly repeatable and prove
 * that safety holds no matter what the model does.
 */

import type { LlmPort, LlmRequest, LlmResponse, ToolCall } from "../../ports/index.ts";
import { LlmUnavailable } from "../../ports/index.ts";

export type ScriptStep =
  | { say: string }
  | { calls: { name: string; args: Record<string, unknown> | string }[]; say?: string }
  | { fail: string }
  | ((request: LlmRequest) => ScriptStep);

export class ScriptedLlm implements LlmPort {
  readonly label = "scripted";
  /** Every request received, for assertions about what the model was shown. */
  readonly requests: LlmRequest[] = [];
  private index = 0;
  private callNo = 0;

  constructor(
    private readonly steps: ScriptStep[],
    /** What to do when the script runs out. "loop" repeats the last step forever (a model that never stops). */
    private readonly whenExhausted: "say" | "loop" = "say",
  ) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(structuredClone(request));
    let step: ScriptStep | undefined = this.steps[this.index];
    if (step === undefined) {
      step = this.whenExhausted === "loop" ? this.steps[this.steps.length - 1] : undefined;
    } else {
      this.index += 1;
    }
    if (step === undefined) step = { say: "Is there anything else I can help with?" };
    while (typeof step === "function") step = step(request);

    if ("fail" in step) throw new LlmUnavailable(step.fail);
    const toolCalls: ToolCall[] =
      "calls" in step
        ? step.calls.map((c) => ({
            id: `call_${++this.callNo}`,
            name: c.name,
            arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args),
          }))
        : [];
    return {
      content: "say" in step && step.say !== undefined ? step.say : null,
      toolCalls,
      model: "scripted",
      usage: null,
    };
  }
}

/** The most recent tool result the model was shown, parsed. Handy inside function steps. */
export function lastToolResult(request: LlmRequest): Record<string, unknown> | null {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const m = request.messages[i]!;
    if (m.role === "tool" && m.content) {
      try {
        return JSON.parse(m.content) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
  return null;
}
