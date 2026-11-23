import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import {
  CONVERSATION_MEMORY_CHANGES_ITEM_TYPE,
  CONVERSATION_PLAN_ITEM_TYPE,
  CONVERSATION_SUBAGENTS_ITEM_TYPE,
  CONVERSATION_TRACE_STEP_LIMIT,
  CONVERSATION_TRACE_TEXT_LIMIT,
  type ConversationMessage,
  type ConversationTraceStep,
  type ConversationTraceStepKind,
  type ConversationTurnTrace,
} from "@openbot/contracts/ipc";
import { redactText } from "@openbot/logging";

export interface ToolOutcome {
  tool: string | null;
  result: string | null;
}

interface RunningTrace {
  startedAt: string;
  steps: ConversationTraceStep[];
  open: Map<string, ConversationTraceStep>;
  lastEventAt: Map<string, string>;
  lastItemId: string | null;
  segments: Map<string, number>;
  modelCalls: number | null;
  outcomes: Map<string, ToolOutcome>;
}

export class TurnTraces {
  readonly #turns = new Map<string, RunningTrace>();

  begin(turnId: string, startedAt: string): void {
    this.#turns.set(turnId, {
      startedAt,
      steps: [],
      open: new Map(),
      lastEventAt: new Map(),
      lastItemId: null,
      segments: new Map(),
      modelCalls: null,
      outcomes: new Map(),
    });
  }

  countModelCall(turnId: string): void {
    const trace = this.#turns.get(turnId);
    if (trace) trace.modelCalls = (trace.modelCalls ?? 0) + 1;
  }

  observe(
    turnId: string,
    itemId: string,
    kind: ConversationTraceStepKind,
    event: {
      completed: boolean;
      failed?: boolean;
      text?: string | null;
      command?: string | null;
      recipientAgentIds?: string[] | null;
      error?: string | null;
      tool?: string | null;
      result?: string | null;
    },
  ): void {
    const trace = this.#turns.get(turnId);
    if (!trace || !itemId || itemId.length > INPUT_LIMITS.identifier) return;
    const now = new Date().toISOString();
    let step = trace.open.get(itemId);
    if (step && step.kind !== "tool" && kind !== "tool" && trace.lastItemId !== itemId) {
      // Another step came between: the open segment ends at its last event. A completion only ends it.
      step.endedAt = trace.lastEventAt.get(itemId) ?? step.startedAt;
      if (event.completed) {
        step.kind = kind;
        trace.open.delete(itemId);
        return;
      }
      step = undefined;
    }
    // A repeated completion of an item whose last segment has ended starts no new one.
    if (!step && event.completed && trace.segments.has(itemId)) return;
    trace.lastItemId = itemId;
    if (!step) {
      if (trace.steps.length >= CONVERSATION_TRACE_STEP_LIMIT) return;
      const segment = (trace.segments.get(itemId) ?? 0) + 1;
      const id = segment === 1 ? itemId : `${itemId}#${segment}`;
      if (id.length > INPUT_LIMITS.identifier) return;
      trace.segments.set(itemId, segment);
      step = { id, kind, startedAt: now, endedAt: null };
      trace.steps.push(step);
      trace.open.set(itemId, step);
    }
    if (step.kind !== "tool") {
      step.kind = kind;
      trace.lastEventAt.set(itemId, now);
    }
    if (kind === "tool" && step.text === undefined && event.text)
      step.text = event.text.slice(0, CONVERSATION_TRACE_TEXT_LIMIT);
    const command = event.command?.trim();
    if (kind === "tool" && step.command === undefined && command)
      step.command = redactText(command).slice(0, CONVERSATION_TRACE_TEXT_LIMIT);
    if (kind === "tool" && step.recipientAgentIds === undefined && event.recipientAgentIds?.length)
      step.recipientAgentIds = [...event.recipientAgentIds];
    if (kind === "tool" && step.error === undefined && event.error) step.error = event.error;
    if (event.completed && step.endedAt === null) step.endedAt = now;
    if (event.completed && event.failed) step.failed = true;
    if (event.completed) trace.open.delete(itemId);
    if (step.kind === "tool" && (event.tool || event.result)) {
      const outcome = trace.outcomes.get(itemId);
      trace.outcomes.set(itemId, {
        tool: outcome?.tool ?? event.tool ?? null,
        result: event.result ?? outcome?.result ?? null,
      });
    }
  }

  toolOutcomes(turnId: string): ReadonlyMap<string, ToolOutcome> {
    return this.#turns.get(turnId)?.outcomes ?? new Map();
  }

  take(turnId: string, endedAt: string): ConversationTurnTrace | null {
    const trace = this.#turns.get(turnId);
    this.#turns.delete(turnId);
    if (!trace) return null;
    // A thought that the turn's end completes ends at its own last event, not at the end of the turn.
    for (const [itemId, step] of trace.open)
      if (step.kind !== "tool" && step.endedAt === null) step.endedAt = trace.lastEventAt.get(itemId) ?? null;
    return {
      startedAt: trace.startedAt,
      endedAt,
      steps: trace.steps,
      ...(trace.modelCalls === null ? {} : { modelCalls: trace.modelCalls }),
    };
  }

  drop(turnId: string): void {
    this.#turns.delete(turnId);
  }

  clear(): void {
    this.#turns.clear();
  }
}

export function traceMessage(
  messages: readonly ConversationMessage[],
  turnId: string,
): ConversationMessage | undefined {
  let thinking: ConversationMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.author !== "assistant" || message.turnId !== turnId) continue;
    if (message.itemType === "commentary") {
      thinking ??= message;
      continue;
    }
    if (
      message.itemType === "question_prompt" ||
      message.itemType === CONVERSATION_PLAN_ITEM_TYPE ||
      message.itemType === CONVERSATION_SUBAGENTS_ITEM_TYPE ||
      message.itemType === CONVERSATION_MEMORY_CHANGES_ITEM_TYPE
    )
      continue;
    if (message.text.trim()) return message;
  }
  return thinking;
}
