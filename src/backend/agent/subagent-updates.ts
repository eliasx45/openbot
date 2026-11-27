import {
  CONVERSATION_SUBAGENT_STEP_LIMIT,
  type ConversationSubagent,
  type ConversationSubagentStatus,
  type ConversationSubagentStep,
  type ConversationSubagentStepKind,
  clampConversationSubagents,
  isConversationSubagents,
} from "@openbot/contracts/ipc";
import { type DynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { isRecord } from "../protocol";
import { type ClaudePlanState, foldClaudePlanCall, newClaudePlanState } from "./plan-updates";

export const SUBAGENTS_UPDATED_METHOD = "turn/subagents/updated";

export function subagentsFromNotification(params: unknown): ConversationSubagent[] | null {
  if (!isRecord(params) || !isConversationSubagents(params.subagents)) return null;
  return clampConversationSubagents(params.subagents);
}

function subagentToolStep(name: string, input: unknown): { kind: ConversationSubagentStepKind; text: string } {
  const fields = isRecord(input) ? input : {};
  const field = (key: string) => (isString(fields[key]) ? fields[key] : "");
  switch (name) {
    case "Read":
    case "NotebookRead":
      return { kind: "read", text: field("file_path") || field("notebook_path") };
    case "Grep":
    case "Glob":
      return { kind: "search", text: field("pattern") };
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return { kind: "edit", text: field("file_path") || field("notebook_path") };
    case "Bash":
      return { kind: "command", text: field("command") };
    case "WebSearch":
      return { kind: "web", text: field("query") };
    case "WebFetch":
      return { kind: "web", text: field("url") };
    default:
      return { kind: "tool", text: name };
  }
}

export function pushSubagentStep(subagent: ConversationSubagent, step: ConversationSubagentStep): boolean {
  const text = step.text.trim();
  if (!text) return false;
  const existing = subagent.steps.findIndex((candidate) => candidate.id === step.id);
  if (existing >= 0) subagent.steps[existing] = { ...step, text };
  else subagent.steps.push({ ...step, text });
  if (subagent.steps.length > CONVERSATION_SUBAGENT_STEP_LIMIT)
    subagent.steps.splice(0, subagent.steps.length - CONVERSATION_SUBAGENT_STEP_LIMIT);
  return true;
}

export function pushSubagentReport(subagent: ConversationSubagent, text: string): void {
  const last = subagent.steps.at(-1);
  if (last?.kind === "text" && last.id !== `${subagent.id}:result` && last.text === text.trim()) return;
  pushSubagentStep(subagent, { id: `${subagent.id}:result`, kind: "text", text });
}

export function endSubagent(
  subagent: ConversationSubagent,
  status: Exclude<ConversationSubagentStatus, "running">,
  endedAt: string,
  error: string | null = null,
): boolean {
  if (subagent.status !== "running") return false;
  subagent.status = status;
  subagent.endedAt = endedAt;
  if (error) subagent.error = error;
  return true;
}

interface SubagentTurn {
  subagents: ConversationSubagent[];
  ended: boolean;
}

export interface SubagentState {
  turns: Map<string, SubagentTurn>;
  turnOf: Map<string, string>;
  aliases: Map<string, string>;
  streams: Map<string, Map<string, string>>;
  /** Fork: the task list each subagent keeps with its own tools, under the subagent's id. */
  plans?: Map<string, ClaudePlanState>;
  /** Fork: the main agent's `SendMessage` calls that wait for their result, under the call's id. */
  sends?: Map<string, { to: string; summary: string; message: string }>;
  /**
   * Fork (FEATURES.md #78): the subagents whose model is still the guess made at the call, not one
   * the provider reported, with whether their effort was the parent's too.
   */
  guessedModels?: Map<string, { inheritedEffort: boolean }>;
}

/** Fork (FEATURES.md #78): the model and effort a subagent runs on, as far as they are known. */
export interface SubagentModelPick {
  model?: string | null | undefined;
  effort?: string | null | undefined;
}

/**
 * Fork: `{ model, effort }` for a subagent: what the call asked for, else what the parent runs on.
 * A blank value is left out.
 */
export function subagentModelFields(
  requested: SubagentModelPick,
  parent: SubagentModelPick | undefined,
): Pick<ConversationSubagent, "model" | "effort"> {
  const pick = (value: string | null | undefined) => (value?.trim() ? value.trim() : undefined);
  const model = pick(requested.model) ?? pick(parent?.model);
  const effort = pick(requested.effort) ?? pick(parent?.effort);
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

export function newSubagentState(): SubagentState {
  return { turns: new Map(), turnOf: new Map(), aliases: new Map(), streams: new Map() };
}

const CLAUDE_SUBAGENT_TOOLS = new Set(["Agent", "Task"]);

export interface SubagentChange {
  turnId: string;
  subagents: ConversationSubagent[];
}

export function subagentChange(state: SubagentState, turnId: string | undefined): SubagentChange | null {
  const turn = turnId ? state.turns.get(turnId) : undefined;
  if (!turnId || !turn) return null;
  const subagents = clampConversationSubagents(turn.subagents) ?? [];
  if (turn.ended && turn.subagents.every((subagent) => subagent.status !== "running")) {
    state.turns.delete(turnId);
    for (const subagent of turn.subagents) {
      state.turnOf.delete(subagent.id);
      state.streams.delete(subagent.id);
      state.guessedModels?.delete(subagent.id);
    }
    for (const [alias, id] of state.aliases) if (!state.turnOf.has(id)) state.aliases.delete(alias);
  }
  return { turnId, subagents };
}

export function subagentFor(state: SubagentState, id: unknown): ConversationSubagent | undefined {
  if (!isString(id)) return undefined;
  const turnId = state.turnOf.get(id);
  return turnId ? state.turns.get(turnId)?.subagents.find((subagent) => subagent.id === id) : undefined;
}

export function startSubagent(
  state: SubagentState,
  turnId: string,
  subagent: ConversationSubagent,
): SubagentChange | null {
  const turn = state.turns.get(turnId) ?? { subagents: [], ended: false };
  turn.subagents.push(subagent);
  state.turns.set(turnId, turn);
  state.turnOf.set(subagent.id, turnId);
  return subagentChange(state, turnId);
}

export function dropSubagent(state: SubagentState, id: string): SubagentChange | null {
  const turnId = state.turnOf.get(id);
  const turn = turnId ? state.turns.get(turnId) : undefined;
  if (!turnId || !turn) return null;
  turn.subagents = turn.subagents.filter((subagent) => subagent.id !== id);
  state.turnOf.delete(id);
  state.streams.delete(id);
  return subagentChange(state, turnId);
}

export function foldClaudeSubagentCall(
  state: SubagentState,
  turnId: string,
  call: { id: string; name: string; input: unknown },
  now: string,
  parent?: SubagentModelPick,
  resolveModel?: (alias: string) => string | undefined,
): SubagentChange | null {
  if (call.name === "SendMessage" && isRecord(call.input)) {
    const field = (key: string) => (isRecord(call.input) && isString(call.input[key]) ? call.input[key] : "");
    state.sends ??= new Map();
    state.sends.set(call.id, { to: field("to"), summary: field("summary"), message: field("message") });
    return null;
  }
  if (!CLAUDE_SUBAGENT_TOOLS.has(call.name) || state.turnOf.has(call.id)) return null;
  const input = isRecord(call.input) ? call.input : {};
  const agentType = isString(input.subagent_type) ? input.subagent_type : null;
  // Fork: the Agent tool's `model` is an alias (`sonnet`, `opus`, `haiku`, `inherit`).
  const alias = isString(input.model) && input.model.trim() !== "inherit" ? input.model.trim() : "";
  const effort = isString(input.effort) ? input.effort.trim() : "";
  state.guessedModels ??= new Map();
  state.guessedModels.set(call.id, { inheritedEffort: !effort });
  return startSubagent(state, turnId, {
    id: call.id,
    title: isString(input.description) ? input.description : (agentType ?? ""),
    agentType,
    prompt: isString(input.prompt) ? input.prompt : null,
    status: "running",
    startedAt: now,
    endedAt: null,
    steps: [],
    error: null,
    ...(input.run_in_background === true ? { background: true as const } : {}),
    ...subagentModelFields({ model: alias ? (resolveModel?.(alias) ?? alias) : null, effort }, parent),
  });
}

function noteReportedModel(state: SubagentState, subagent: ConversationSubagent, message: DynamicRecord): boolean {
  const guess = state.guessedModels?.get(subagent.id);
  const reported = isString(message.model) ? message.model.trim() : "";
  if (!guess || !reported || reported.startsWith("<")) return false;
  state.guessedModels?.delete(subagent.id);
  if (subagent.model !== undefined && sameModelId(subagent.model, reported)) return false;
  subagent.model = reported;
  if (guess.inheritedEffort) delete subagent.effort;
  return true;
}

function sameModelId(left: string, right: string): boolean {
  const base = (id: string) => id.replace(/\[[^\]]*\]$/u, "").toLowerCase();
  return base(left) === base(right);
}

export function foldClaudeSubagentMessage(
  state: SubagentState,
  parentToolUseId: string,
  messageId: string,
  message: unknown,
): SubagentChange | null {
  const subagent = subagentFor(state, parentToolUseId);
  if (!subagent || !isRecord(message) || !Array.isArray(message.content)) return null;
  let changed = noteReportedModel(state, subagent, message);
  message.content.forEach((block, index) => {
    if (!isRecord(block)) return;
    const id = `${messageId}:${index}`;
    // Fork: a task-list call of the subagent becomes its plan, not a "TodoWrite" step.
    if (block.type === "tool_use" && isString(block.name) && foldSubagentPlan(state, subagent, block)) {
      changed = true;
      return;
    }
    const step =
      block.type === "thinking" && isString(block.thinking)
        ? { id, kind: "thinking" as const, text: block.thinking }
        : block.type === "text" && isString(block.text)
          ? { id, kind: "text" as const, text: block.text }
          : block.type === "tool_use" && isString(block.name)
            ? { id: isString(block.id) ? block.id : id, ...subagentToolStep(block.name, block.input) }
            : null;
    if (step && pushSubagentStep(subagent, step)) changed = true;
  });
  return changed ? subagentChange(state, state.turnOf.get(parentToolUseId)) : null;
}

const SUBAGENT_PLAN_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate"]);

function foldSubagentPlan(state: SubagentState, subagent: ConversationSubagent, block: DynamicRecord): boolean {
  const name = isString(block.name) ? block.name : "";
  if (!SUBAGENT_PLAN_TOOLS.has(name)) return false;
  state.plans ??= new Map();
  let plan = state.plans.get(subagent.id);
  if (!plan) {
    plan = newClaudePlanState();
    state.plans.set(subagent.id, plan);
  }
  const callId = isString(block.id) ? block.id : `${subagent.id}:${plan.steps.size}`;
  const steps = foldClaudePlanCall(plan, { id: callId, name, input: block.input });
  if (!steps) return false;
  if (name === "TaskCreate" && plan.creates.delete(callId)) {
    const created = plan.steps.get(callId);
    if (created) {
      plan.steps.delete(callId);
      plan.steps.set(String(plan.steps.size + 1), created);
    }
  }
  subagent.plan = [...plan.steps.values()].map((step) => ({
    text: step.step,
    ...(step.activeText ? { activeText: step.activeText } : {}),
    status: step.status,
  }));
  return true;
}

export function foldClaudeSubagentResult(
  state: SubagentState,
  toolUseId: string,
  result: unknown,
  isError: boolean,
  text: string,
  now: string,
): SubagentChange | null {
  const subagent = subagentFor(state, toolUseId);
  if (!subagent) return null;
  if (isError) {
    endSubagent(subagent, "failed", now, text);
    return subagentChange(state, state.turnOf.get(toolUseId));
  }
  // Fork (docs/fork/FEATURES.md, "Agents continue after a restart"): `SendMessage` continues a
  // subagent by this id, also after a restart stopped it.
  const providerAgentId = isRecord(result) && isString(result.agentId) ? result.agentId.trim() : "";
  const newId = providerAgentId !== "" && subagent.providerAgentId !== providerAgentId;
  if (newId) subagent.providerAgentId = providerAgentId;
  if (isRecord(result) && (result.isAsync === true || result.status === "async_launched")) {
    subagent.background = true;
    return newId ? subagentChange(state, state.turnOf.get(toolUseId)) : null;
  }
  if (subagent.background) return newId ? subagentChange(state, state.turnOf.get(toolUseId)) : null;
  pushSubagentReport(subagent, claudeResultText(result));
  endSubagent(subagent, "completed", now);
  return subagentChange(state, state.turnOf.get(toolUseId));
}

export function foldClaudeSubagentResume(
  state: SubagentState,
  turnId: string,
  toolUseId: string,
  result: unknown,
  isError: boolean,
  text: string,
  now: string,
): SubagentChange | null {
  const send = state.sends?.get(toolUseId);
  if (!send) return null;
  state.sends?.delete(toolUseId);
  if (isError || state.turnOf.has(toolUseId)) return null;
  const fields = isRecord(result) ? result : parsedRecord(text);
  const resumedId = isString(fields?.resumedAgentId) ? fields.resumedAgentId.trim() : "";
  if (!resumedId || fields?.success === false) return null;
  let earlier: ConversationSubagent | undefined;
  for (const turn of state.turns.values())
    for (const subagent of turn.subagents) if (subagent.providerAgentId === resumedId) earlier = subagent;
  state.aliases.set(resumedId, toolUseId);
  return startSubagent(state, turnId, {
    id: toolUseId,
    title: earlier?.title || send.summary || resumedId,
    agentType: earlier?.agentType ?? null,
    prompt: send.message || null,
    status: "running",
    startedAt: now,
    endedAt: null,
    steps: [],
    error: null,
    background: true,
    providerAgentId: resumedId,
    ...(earlier?.model ? { model: earlier.model } : {}),
    ...(earlier?.effort ? { effort: earlier.effort } : {}),
  });
}

function parsedRecord(text: string): DynamicRecord | null {
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function claudeResultText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return "";
  return result.content
    .filter(isRecord)
    .map((part) => (isString(part.text) ? part.text : ""))
    .join("\n");
}

export function foldClaudeTaskMessage(state: SubagentState, message: unknown, now: string): SubagentChange | null {
  if (!isRecord(message) || message.type !== "system") return null;
  if (
    message.subtype === "task_started" &&
    isString(message.task_id) &&
    isString(message.tool_use_id) &&
    state.turnOf.has(message.tool_use_id)
  )
    state.aliases.set(message.task_id, message.tool_use_id);
  const toolUseId = message.tool_use_id ?? (isString(message.task_id) ? state.aliases.get(message.task_id) : undefined);
  const subagent = subagentFor(state, toolUseId);
  if (!subagent) return null;
  const turnId = state.turnOf.get(subagent.id);
  if (message.subtype === "task_started" || message.subtype === "task_updated") {
    const backgrounded =
      message.is_backgrounded === true || (isRecord(message.patch) && message.patch.is_backgrounded === true);
    if (!backgrounded || subagent.background) return null;
    subagent.background = true;
    return subagentChange(state, turnId);
  }
  if (message.subtype !== "task_notification") return null;
  const summary = isString(message.summary) ? message.summary : "";
  if (message.status === "completed") {
    pushSubagentReport(subagent, summary);
    endSubagent(subagent, "completed", now);
  } else endSubagent(subagent, message.status === "failed" ? "failed" : "stopped", now, summary || null);
  return subagentChange(state, turnId);
}

export function endSubagentTurn(state: SubagentState, turnId: string, now: string): SubagentChange | null {
  // A `SendMessage` result comes within its turn, so a call left here got none.
  state.sends?.clear();
  const turn = state.turns.get(turnId);
  if (!turn) return null;
  turn.ended = true;
  let changed = false;
  for (const subagent of turn.subagents)
    if (!subagent.background) changed = endSubagent(subagent, "stopped", now) || changed;
  const update = subagentChange(state, turnId);
  return changed ? update : null;
}

export function runningBackgroundSubagents(
  state: SubagentState,
): Array<{ turnId: string; subagent: ConversationSubagent }> {
  return [...state.turns].flatMap(([turnId, turn]) =>
    turn.subagents
      .filter((subagent) => subagent.background && subagent.status === "running")
      .map((subagent) => ({ turnId, subagent: { ...subagent } })),
  );
}

export function stopSubagents(state: SubagentState, now: string, turnIds?: ReadonlySet<string>): SubagentChange[] {
  if (!turnIds) state.sends?.clear();
  return [...state.turns].flatMap(([turnId, turn]) => {
    if (turnIds && !turnIds.has(turnId)) return [];
    turn.ended = true;
    let changed = false;
    for (const subagent of turn.subagents) changed = endSubagent(subagent, "stopped", now) || changed;
    const update = subagentChange(state, turnId);
    return changed && update ? [update] : [];
  });
}

export function stopRunningSubagents(
  subagents: ConversationSubagent[] | undefined,
  now: string,
  { background, keep }: { background: boolean; keep?: ReadonlySet<string> },
): boolean {
  let changed = false;
  for (const subagent of subagents ?? [])
    if ((background || !subagent.background) && !keep?.has(subagent.id))
      changed = endSubagent(subagent, "stopped", now) || changed;
  return changed;
}

export function foldCodexSubagentItem(
  current: readonly ConversationSubagent[],
  item: DynamicRecord,
  now: string,
  models?: CodexSubagentModels,
): ConversationSubagent[] | null {
  const subagents = current.map((subagent) => ({ ...subagent, steps: [...subagent.steps] }));
  if (item.type === "subAgentActivity") return foldCodexSubagentActivity(subagents, item, models);
  let changed = false;
  const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds.filter(isString) : [];
  if (item.tool === "spawnAgent") {
    const prompt = isString(item.prompt) ? item.prompt : null;
    for (const receiver of receivers) {
      if (subagents.some((subagent) => subagent.id === receiver)) continue;
      // Fork (FEATURES.md #78): the model Codex resolved for the thread, else the one the call asked
      // for, else the parent's. `model` used to show as the agent type.
      const resolved = models?.resolved.get(receiver);
      models?.resolved.delete(receiver);
      subagents.push({
        id: receiver,
        title: prompt?.trim().split("\n", 1)[0] ?? "",
        agentType: null,
        prompt,
        status: "running",
        startedAt: now,
        endedAt: null,
        steps: [],
        error: null,
        ...subagentModelFields(
          {
            model: resolved?.model ?? (isString(item.model) ? item.model : null),
            effort: resolved?.effort ?? (isString(item.reasoningEffort) ? item.reasoningEffort : null),
          },
          models?.parent,
        ),
      });
      changed = true;
    }
    if (item.status === "failed")
      for (const subagent of subagents)
        if (receivers.includes(subagent.id)) changed = endSubagent(subagent, "failed", now) || changed;
  }
  const states = isRecord(item.agentsStates) ? item.agentsStates : {};
  for (const subagent of subagents) {
    const state = states[subagent.id];
    if (!isRecord(state)) continue;
    const message = isString(state.message) ? state.message : "";
    const status = codexSubagentStatus(state.status);
    if (status === "completed") {
      pushSubagentReport(subagent, message);
      changed = endSubagent(subagent, status, now) || changed;
    } else if (status) changed = endSubagent(subagent, status, now, message || null) || changed;
  }
  return changed ? subagents : null;
}

export interface CodexSubagentModels {
  parent?: SubagentModelPick | undefined;
  resolved: Map<string, { model: string | null; effort: string | null }>;
}

const CODEX_RESOLVED_LIMIT = 48;

function foldCodexSubagentActivity(
  subagents: ConversationSubagent[],
  item: DynamicRecord,
  models: CodexSubagentModels | undefined,
): ConversationSubagent[] | null {
  const threadId = isString(item.agentThreadId) ? item.agentThreadId : "";
  const model = isString(item.model) && item.model.trim() ? item.model.trim() : null;
  const effort = isString(item.reasoningEffort) && item.reasoningEffort.trim() ? item.reasoningEffort.trim() : null;
  if (!threadId || (!model && !effort)) return null;
  const subagent = subagents.find((candidate) => candidate.id === threadId);
  if (!subagent) {
    if (models) {
      models.resolved.set(threadId, { model, effort });
      for (const id of models.resolved.keys()) {
        if (models.resolved.size <= CODEX_RESOLVED_LIMIT) break;
        models.resolved.delete(id);
      }
    }
    return null;
  }
  let changed = false;
  if (model && subagent.model !== model) {
    subagent.model = model;
    changed = true;
  }
  if (effort && subagent.effort !== effort) {
    subagent.effort = effort;
    changed = true;
  }
  return changed ? subagents : null;
}

function codexSubagentStatus(status: unknown): Exclude<ConversationSubagentStatus, "running"> | null {
  if (status === "completed") return "completed";
  if (status === "errored" || status === "failed") return "failed";
  if (status === "shutdown" || status === "notFound" || status === "interrupted") return "stopped";
  return null;
}

export function foldCodexChildItem(
  current: readonly ConversationSubagent[],
  childThreadId: string,
  item: DynamicRecord,
): ConversationSubagent[] | null {
  const index = current.findIndex((subagent) => subagent.id === childThreadId && subagent.status === "running");
  const step = index >= 0 ? codexChildStep(item) : null;
  if (!step) return null;
  const subagents = current.map((subagent) => ({ ...subagent, steps: [...subagent.steps] }));
  const subagent = subagents[index];
  return subagent && pushSubagentStep(subagent, step) ? subagents : null;
}

export function endCodexChild(
  current: readonly ConversationSubagent[],
  childThreadId: string,
  turnStatus: string | null,
  now: string,
): ConversationSubagent[] | null {
  const subagents = current.map((subagent) => ({ ...subagent, steps: [...subagent.steps] }));
  const subagent = subagents.find((candidate) => candidate.id === childThreadId);
  const status = turnStatus === "failed" ? "failed" : turnStatus === "interrupted" ? "stopped" : "completed";
  return subagent && endSubagent(subagent, status, now) ? subagents : null;
}

function codexChildStep(item: DynamicRecord): ConversationSubagentStep | null {
  if (!isString(item.id)) return null;
  const id = item.id;
  const field = (record: unknown, key: string) => (isRecord(record) && isString(record[key]) ? record[key] : "");
  const lines = (value: unknown) => (Array.isArray(value) ? value.filter(isString).join("\n") : "");
  switch (item.type) {
    case "commandExecution":
      return { id, kind: "command", text: field(item, "command") };
    case "fileChange":
      return {
        id,
        kind: "edit",
        text: Array.isArray(item.changes) ? item.changes.map((change) => field(change, "path")).join(", ") : "",
      };
    case "webSearch":
      return { id, kind: "web", text: field(item, "query") || field(item.action, "url") };
    case "imageView":
      return { id, kind: "read", text: field(item, "path") };
    case "mcpToolCall":
    case "dynamicToolCall":
      return { id, kind: "tool", text: field(item, "tool") };
    case "agentMessage":
      return { id, kind: "text", text: field(item, "text") };
    case "reasoning":
      return { id, kind: "thinking", text: lines(item.summary) || lines(item.content) };
    default:
      return null;
  }
}
