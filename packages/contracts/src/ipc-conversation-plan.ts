import { INPUT_LIMITS } from "./input-limits";
import { isBoundedString, isIdentifier } from "./ipc-bounded-values";
import { isDynamicRecord, isOneOf } from "./runtime-values";

/**
 * The plan an agent works through in one turn. Each provider has its own plan tool (Claude
 * `TodoWrite` and its task tools, Codex `update_plan`, the ACP `plan` update); the backend maps all
 * of them to this one shape, and each update holds the full list.
 */
export const CONVERSATION_PLAN_ITEM_TYPE = "plan";

export const CONVERSATION_PLAN_STEP_STATUSES = ["pending", "inProgress", "completed"] as const;
export type ConversationPlanStepStatus = (typeof CONVERSATION_PLAN_STEP_STATUSES)[number];

export interface ConversationPlanStep {
  id: string;
  text: string;
  /** The present-tense form a provider shows while the step runs, such as "Running the tests". */
  activeText?: string;
  status: ConversationPlanStepStatus;
}

export interface ConversationPlan {
  explanation: string | null;
  steps: ConversationPlanStep[];
  /**
   * Fork: the id of the step that the agent started last and that still runs. An agent can keep
   * more than one step in progress, so the first one is not always the work of now. Absent from a
   * host before this field; `currentPlanStep` then takes the last running step.
   */
  current?: string;
}

export const CONVERSATION_PLAN_STEP_LIMIT = 100;
const STEP_TEXT_LIMIT = INPUT_LIMITS.promptQuestion;
const EXPLANATION_LIMIT = INPUT_LIMITS.promptQuestion;

export function isConversationPlan(value: unknown): value is ConversationPlan {
  return (
    isDynamicRecord(value) &&
    (value.explanation === null || isBoundedString(value.explanation, EXPLANATION_LIMIT)) &&
    Array.isArray(value.steps) &&
    value.steps.length <= CONVERSATION_PLAN_STEP_LIMIT &&
    value.steps.every(isConversationPlanStep) &&
    (value.current === undefined || isIdentifier(value.current))
  );
}

function isConversationPlanStep(value: unknown): value is ConversationPlanStep {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isBoundedString(value.text, STEP_TEXT_LIMIT) &&
    (value.activeText === undefined || isBoundedString(value.activeText, STEP_TEXT_LIMIT)) &&
    isOneOf(CONVERSATION_PLAN_STEP_STATUSES, value.status)
  );
}

/**
 * The plan inside the bounds of `isConversationPlan`, with blank steps removed. The backend applies
 * it before each write, so a stored plan always decodes. Returns null when no step is left.
 */
export function clampConversationPlan(plan: ConversationPlan): ConversationPlan | null {
  const steps: ConversationPlanStep[] = [];
  const ids = new Set<string>();
  let current: string | undefined;
  for (const step of plan.steps) {
    if (steps.length >= CONVERSATION_PLAN_STEP_LIMIT) break;
    const text = clampText(step.text);
    if (!text) continue;
    let id = clampText(step.id).slice(0, INPUT_LIMITS.identifier) || String(steps.length);
    if (!isIdentifier(id) || ids.has(id)) id = `step-${steps.length}`;
    ids.add(id);
    const activeText = step.activeText === undefined ? "" : clampText(step.activeText);
    const status = isOneOf(CONVERSATION_PLAN_STEP_STATUSES, step.status) ? step.status : "pending";
    steps.push({ id, text, ...(activeText ? { activeText } : {}), status });
    // The clamp can rename a step; the current step follows its step, and names only a running one.
    if (plan.current !== undefined && step.id === plan.current && status === "inProgress") current = id;
  }
  if (!steps.length) return null;
  const explanation = plan.explanation === null ? "" : clampText(plan.explanation);
  return { explanation: explanation || null, steps, ...(current === undefined ? {} : { current }) };
}

/**
 * Fork: the step the agent works on now: the plan's `current` step while it runs, else the last
 * running step. Before, every view took the first running step, so a plan with two steps in
 * progress showed step 1 while the agent worked on a later one (Elias, 8 Nov 2026: "stay running on
 * step 1 visually even though it's on a later step"). `undefined` when no step runs.
 */
export function currentPlanStep<Step extends { id: string; status: ConversationPlanStepStatus }>(plan: {
  steps: readonly Step[];
  current?: string | undefined;
}): Step | undefined {
  const named = plan.current === undefined ? undefined : plan.steps.find((step) => step.id === plan.current);
  if (named?.status === "inProgress") return named;
  return plan.steps.findLast((step) => step.status === "inProgress");
}

function clampText(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, STEP_TEXT_LIMIT);
}

/**
 * The plan as a markdown checklist. It is the message text, so a client that does not know the
 * plan field (a released Team API peer, the mobile app) still shows a readable list.
 */
export function conversationPlanText(plan: ConversationPlan): string {
  const lines = plan.steps.map((step) => `- [${step.status === "completed" ? "x" : " "}] ${step.text}`);
  return plan.explanation ? `${plan.explanation}\n\n${lines.join("\n")}` : lines.join("\n");
}

const CHECKLIST_LINE = /^- \[( |x)\] (.+)$/u;

/**
 * The plan read back from `conversationPlanText`. A checklist has no running step, so every open
 * step is pending. Returns null when the text is not a checklist.
 */
export function parseConversationPlanText(text: string): ConversationPlan | null {
  const lines = text.split("\n");
  const firstStep = lines.findIndex((line) => CHECKLIST_LINE.test(line));
  if (firstStep < 0) return null;
  const steps: ConversationPlanStep[] = [];
  for (const line of lines.slice(firstStep)) {
    const match = CHECKLIST_LINE.exec(line);
    if (!match) return null;
    steps.push({ id: String(steps.length), text: match[2] ?? "", status: match[1] === "x" ? "completed" : "pending" });
  }
  const explanation = lines.slice(0, firstStep).join("\n").trim();
  return clampConversationPlan({ explanation: explanation || null, steps });
}
