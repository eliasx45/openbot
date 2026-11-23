import { isBoundedString, isIdentifier, isNullableBoundedString } from "./ipc-bounded-values";
import { isDynamicRecord, isOneOf } from "./runtime-values";

export const CONVERSATION_SUBAGENTS_ITEM_TYPE = "subagents";

export const CONVERSATION_SUBAGENT_STATUSES = ["running", "completed", "failed", "stopped"] as const;
export type ConversationSubagentStatus = (typeof CONVERSATION_SUBAGENT_STATUSES)[number];

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
  id: string;
  kind: ConversationSubagentStepKind;
  text: string;
}

export interface ConversationSubagent {
  id: string;
  title: string;
  agentType: string | null;
  prompt: string | null;
  status: ConversationSubagentStatus;
  startedAt: string;
  endedAt: string | null;
  steps: ConversationSubagentStep[];
  error: string | null;
  background?: true;
  /**
   * Fork (docs/fork/FEATURES.md, "Agents continue after a restart"): the provider's own id of the
   * subagent, which Claude's `SendMessage` takes to continue it: the `agentId` of a background
   * `Agent` result. Absent when the provider gave none.
   */
  providerAgentId?: string;
  /** Fork: the subagent's own task list, when it keeps one. */
  plan?: ConversationSubagentPlanStep[];
  /**
   * Fork (docs/fork/FEATURES.md, "Subagents show their model"): the provider's id of the model the
   * subagent runs on, such as `claude-opus-5-5` or `gpt-5.5`: the model the provider reported for the
   * subagent when it did, else the one the call asked for, else the parent's. Absent when unknown,
   * as in records from before this field.
   */
  model?: string;
  /** Fork: the subagent's reasoning effort, such as `high`, when known. */
  effort?: string;
}

export const CONVERSATION_SUBAGENT_LIMIT = 24;
export const CONVERSATION_SUBAGENT_STEP_LIMIT = 40;
export const CONVERSATION_SUBAGENT_TITLE_LIMIT = 300;
const AGENT_TYPE_LIMIT = 80;
const MODEL_LIMIT = 120;
const EFFORT_LIMIT = 40;
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
        value.plan.every(isConversationSubagentPlanStep))) &&
    (value.model === undefined || isBoundedString(value.model, MODEL_LIMIT)) &&
    (value.effort === undefined || isBoundedString(value.effort, EFFORT_LIMIT))
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
      ...(optionalText(subagent.model, MODEL_LIMIT) ? { model: optionalText(subagent.model, MODEL_LIMIT) } : {}),
      ...(optionalText(subagent.effort, EFFORT_LIMIT) ? { effort: optionalText(subagent.effort, EFFORT_LIMIT) } : {}),
    });
  }
  return result.length ? result : null;
}

function clampText(value: string, limit: number, oneLine = true): string {
  return (oneLine ? value.replace(/\s+/gu, " ") : value).trim().slice(0, limit);
}

function nullableText(value: string | null, limit: number, oneLine = true): string | null {
  return value === null ? null : clampText(value, limit, oneLine) || null;
}

function optionalText(value: string | undefined, limit: number): string {
  return value === undefined ? "" : clampText(value, limit);
}

export function conversationSubagentsText(subagents: readonly ConversationSubagent[]): string {
  return subagents.map((subagent) => `- ${subagent.title || subagent.agentType || subagent.id}`).join("\n");
}
