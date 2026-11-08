import { isBoundedString, isIdentifier, isNullableBoundedString } from "./ipc-bounded-values";
import { isDynamicRecord, isOneOf } from "./runtime-values";

/**
 * The subagents that an agent started in one turn: Claude `Task` and `Agent` calls, Codex
 * `spawnAgent` calls, OpenCode child sessions, and the subagent tool calls of Kimi, Cline and Hermes.
 * The backend maps each provider to this one shape. Each update holds the full list, and it is stored
 * on one message of the turn, as the plan is.
 */
export const CONVERSATION_SUBAGENTS_ITEM_TYPE = "subagents";

export const CONVERSATION_SUBAGENT_STATUSES = ["running", "completed", "failed", "stopped"] as const;
export type ConversationSubagentStatus = (typeof CONVERSATION_SUBAGENT_STATUSES)[number];

/**
 * What one step of a subagent did. The text is what the provider sent: the thought, the search, the
 * path, the command or the answer. The screen gives each kind its icon and its label.
 */
export const CONVERSATION_SUBAGENT_STEP_KINDS = [
  "thinking",
  "text",
  "search",
  "read",
  "edit",
  "command",
  "web",
  "tool",
] as const;
export type ConversationSubagentStepKind = (typeof CONVERSATION_SUBAGENT_STEP_KINDS)[number];

/**
 * Fork: the task list a subagent keeps with its own tools (Claude `TodoWrite`), so its progress shows
 * as "2/5 · what it does now" instead of a "TodoWrite" step (Elias, 8 Nov 2026).
 */
export const CONVERSATION_SUBAGENT_PLAN_STATUSES = ["pending", "inProgress", "completed"] as const;
export interface ConversationSubagentPlanStep {
  text: string;
  /** The present-tense text of the step that runs, such as "Rendering before/after". */
  activeText?: string;
  status: (typeof CONVERSATION_SUBAGENT_PLAN_STATUSES)[number];
}
export const CONVERSATION_SUBAGENT_PLAN_LIMIT = 30;
const PLAN_TEXT_LIMIT = 300;

export interface ConversationSubagentStep {
  /** Stays the same when older steps are dropped, so a list keeps its rows. */
  id: string;
  kind: ConversationSubagentStepKind;
  text: string;
}

export interface ConversationSubagent {
  /** The provider's id: the Claude tool-use id, or the Codex thread of the subagent. */
  id: string;
  /** What the agent called the work, such as the Claude `description`. */
  title: string;
  /** The provider's type of subagent, such as the Claude `subagent_type`. */
  agentType: string | null;
  /** What the agent asked the subagent to do. */
  prompt: string | null;
  status: ConversationSubagentStatus;
  startedAt: string;
  endedAt: string | null;
  /** The newest steps, up to `CONVERSATION_SUBAGENT_STEP_LIMIT`. */
  steps: ConversationSubagentStep[];
  error: string | null;
  /** A subagent that works on after the turn ends, such as a Claude `run_in_background` call. */
  background?: true;
  /**
   * Fork (docs/fork/FEATURES.md, "Agents continue after a restart"): the provider's own id of the
   * subagent, which Claude's `SendMessage` takes to continue it: the `agentId` of a background
   * `Agent` result. Absent when the provider gave none.
   */
  providerAgentId?: string;
  /** Fork: the subagent's own task list, when it keeps one. */
  plan?: ConversationSubagentPlanStep[];
}

export const CONVERSATION_SUBAGENT_LIMIT = 24;
export const CONVERSATION_SUBAGENT_STEP_LIMIT = 40;
export const CONVERSATION_SUBAGENT_TITLE_LIMIT = 300;
const AGENT_TYPE_LIMIT = 80;
const PROMPT_LIMIT = 2_000;
const STEP_TEXT_LIMIT = 500;
const ERROR_LIMIT = 500;
const TIME_LIMIT = 160;

export function isConversationSubagents(value: unknown): value is ConversationSubagent[] {
  return Array.isArray(value) && value.length <= CONVERSATION_SUBAGENT_LIMIT && value.every(isConversationSubagent);
}

function isConversationSubagent(value: unknown): value is ConversationSubagent {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isBoundedString(value.title, CONVERSATION_SUBAGENT_TITLE_LIMIT) &&
    isNullableBoundedString(value.agentType, AGENT_TYPE_LIMIT) &&
    isNullableBoundedString(value.prompt, PROMPT_LIMIT) &&
    isOneOf(CONVERSATION_SUBAGENT_STATUSES, value.status) &&
    isBoundedString(value.startedAt, TIME_LIMIT) &&
    isNullableBoundedString(value.endedAt, TIME_LIMIT) &&
    Array.isArray(value.steps) &&
    value.steps.length <= CONVERSATION_SUBAGENT_STEP_LIMIT &&
    value.steps.every(isConversationSubagentStep) &&
    isNullableBoundedString(value.error, ERROR_LIMIT) &&
    (value.background === undefined || value.background === true) &&
    (value.providerAgentId === undefined || isIdentifier(value.providerAgentId)) &&
    (value.plan === undefined ||
      (Array.isArray(value.plan) &&
        value.plan.length <= CONVERSATION_SUBAGENT_PLAN_LIMIT &&
        value.plan.every(isConversationSubagentPlanStep)))
  );
}

function isConversationSubagentPlanStep(value: unknown): value is ConversationSubagentPlanStep {
  return (
    isDynamicRecord(value) &&
    isBoundedString(value.text, PLAN_TEXT_LIMIT) &&
    (value.activeText === undefined || isBoundedString(value.activeText, PLAN_TEXT_LIMIT)) &&
    isOneOf(CONVERSATION_SUBAGENT_PLAN_STATUSES, value.status)
  );
}

function isConversationSubagentStep(value: unknown): value is ConversationSubagentStep {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isOneOf(CONVERSATION_SUBAGENT_STEP_KINDS, value.kind) &&
    isBoundedString(value.text, STEP_TEXT_LIMIT)
  );
}

/**
 * The subagents inside the bounds of `isConversationSubagents`, with blank steps removed. The backend
 * applies it before each write, so a stored list always decodes. Returns null when no subagent is left.
 */
export function clampConversationSubagents(subagents: readonly ConversationSubagent[]): ConversationSubagent[] | null {
  const result: ConversationSubagent[] = [];
  const ids = new Set<string>();
  for (const subagent of subagents) {
    if (result.length >= CONVERSATION_SUBAGENT_LIMIT) break;
    if (!isIdentifier(subagent.id) || ids.has(subagent.id)) continue;
    ids.add(subagent.id);
    const steps = subagent.steps.flatMap((step): ConversationSubagentStep[] => {
      const text = clampText(step.text, STEP_TEXT_LIMIT);
      return text && isIdentifier(step.id) ? [{ id: step.id, kind: step.kind, text }] : [];
    });
    result.push({
      id: subagent.id,
      title: clampText(subagent.title, CONVERSATION_SUBAGENT_TITLE_LIMIT),
      agentType: nullableText(subagent.agentType, AGENT_TYPE_LIMIT),
      prompt: nullableText(subagent.prompt, PROMPT_LIMIT, false),
      status: subagent.status,
      startedAt: subagent.startedAt.slice(0, TIME_LIMIT),
      endedAt: subagent.endedAt === null ? null : subagent.endedAt.slice(0, TIME_LIMIT),
      steps: steps.slice(-CONVERSATION_SUBAGENT_STEP_LIMIT),
      error: nullableText(subagent.error, ERROR_LIMIT),
      ...(subagent.background ? { background: true as const } : {}),
      ...(subagent.providerAgentId && isIdentifier(subagent.providerAgentId)
        ? { providerAgentId: subagent.providerAgentId }
        : {}),
      ...(subagent.plan?.length
        ? {
            plan: subagent.plan.slice(0, CONVERSATION_SUBAGENT_PLAN_LIMIT).map((step) => ({
              text: clampText(step.text, PLAN_TEXT_LIMIT),
              ...(step.activeText ? { activeText: clampText(step.activeText, PLAN_TEXT_LIMIT) } : {}),
              status: step.status,
            })),
          }
        : {}),
    });
  }
  return result.length ? result : null;
}

/** One line, cut to `limit`. A prompt keeps its line breaks. */
function clampText(value: string, limit: number, oneLine = true): string {
  return (oneLine ? value.replace(/\s+/gu, " ") : value).trim().slice(0, limit);
}

function nullableText(value: string | null, limit: number, oneLine = true): string | null {
  return value === null ? null : clampText(value, limit, oneLine) || null;
}

/**
 * The subagents as a markdown list of their titles. It is the message text, so a client that does
 * not know the subagents field (a released Team API peer) still shows what the agent started.
 */
export function conversationSubagentsText(subagents: readonly ConversationSubagent[]): string {
  return subagents.map((subagent) => `- ${subagent.title || subagent.agentType || subagent.id}`).join("\n");
}
