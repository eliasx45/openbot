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

interface RunningTrace {
  startedAt: string;
  /** Every step in start order, the closed thinking segments included. */
  steps: ConversationTraceStep[];
  /** The open step of each provider item id. */
  open: Map<string, ConversationTraceStep>;
  /** The time of the last event of each open step that is not a tool. */
  lastEventAt: Map<string, string>;
  /** The item id of the latest event, to see that another step came between two thinking events. */
  lastItemId: string | null;
  /** How many segments each item id has, for the id of the next one. */
  segments: Map<string, number>;
  /** The model requests that the provider reported. */
  modelCalls: number | null;
}

/**
 * Owns the steps of each running turn, by provider item id, until the turn ends. The providers send
 * no times, so each time is when the host got the event. A turn ends with `take`, which removes it;
 * only a turn that `begin` started records steps, so a compaction turn keeps nothing here.
 *
 * Fork (docs/fork/FEATURES.md, "Long turns stay visible"): Claude keeps all thinking of a turn in one
 * item, so one step covered the whole turn and the trace named it the slowest (Gotham, 8 Nov 2026:
 * "20m 6s"). A thought or message that gets an event after another step had one starts a new segment,
 * and the segment before it ends at its own last event.
 */
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
    });
  }

  /** Counts a model request of the turn, as the provider reports it. */
  countModelCall(turnId: string): void {
    const trace = this.#turns.get(turnId);
    if (trace) trace.modelCalls = (trace.modelCalls ?? 0) + 1;
  }

  /**
   * Records an item event. The first event of an item starts its step; a completion ends it. A later
   * event can change the kind between thinking and message, because Claude marks its thinking late.
   * `text` is the progress text of a tool step; the text of the first event stays. The command and the
   * recipients of a tool step come with its start, but a provider can send them later, so the first
   * event that has them sets them.
   */
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
    },
  ): void {
    const trace = this.#turns.get(turnId);
    // A step id must pass the message guard, or the message that holds the trace would not decode.
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
    // The trace stays on this computer, but a command can hold a token, as a log line can.
    const command = event.command?.trim();
    if (kind === "tool" && step.command === undefined && command)
      step.command = redactText(command).slice(0, CONVERSATION_TRACE_TEXT_LIMIT);
    if (kind === "tool" && step.recipientAgentIds === undefined && event.recipientAgentIds?.length)
      step.recipientAgentIds = [...event.recipientAgentIds];
    if (event.completed && step.endedAt === null) step.endedAt = now;
    if (event.completed && event.failed) step.failed = true;
    if (event.completed) trace.open.delete(itemId);
  }

  /** The trace of a turn that ends now, without its usage. It removes the turn. */
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

/**
 * The message of a turn that holds its trace: its last answer with text, or its last thinking when
 * it has no answer. A question prompt, a plan, the subagents and the memory changes do not hold it.
 */
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
