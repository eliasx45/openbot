import type { ConversationSubagent, ConversationSubagentStepKind } from "@openbot/contracts/ipc";
import { type DynamicRecord, isString } from "@openbot/contracts/runtime-values";
import type { AcpSubagentLaunch } from "../acp-flavor";
import { isRecord } from "../protocol";
import {
  dropSubagent,
  endSubagent,
  pushSubagentReport,
  pushSubagentStep,
  type SubagentChange,
  type SubagentModelPick,
  type SubagentState,
  startSubagent,
  subagentChange,
  subagentFor,
  subagentModelFields,
} from "./subagent-updates";

/** The ACP extension notification that OpenCode sends for the sessions of its subagents. */
export const OPENCODE_CHILD_UPDATE_METHOD = "opencode/session/child_update";

/** The client capability that makes OpenCode send `OPENCODE_CHILD_UPDATE_METHOD`. */
export const OPENCODE_CHILD_SESSION_UPDATES = "opencode/child-session-updates";

/** The fields of an ACP `tool_call` or `tool_call_update` that a subagent card reads. */
export interface AcpSubagentToolCall {
  id: string;
  /** The name that OpenBot shows for the call: the ACP `name`, else the title. */
  name: string;
  status: string | undefined;
  rawInput: unknown;
  rawOutput: unknown;
  content: unknown;
}

/** The text blocks of ACP tool call content, joined. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isRecord(part) && isRecord(part.content) && isString(part.content.text) ? part.content.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** A JSON object in text, or null. Kimi sends the arguments of a call as its content text. */
function jsonRecord(text: string): DynamicRecord | null {
  if (!text.trim().startsWith("{")) return null;
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** The first string among these fields. */
function firstString(record: DynamicRecord | null, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record?.[key];
    if (isString(value) && value.trim()) return value;
  }
  return null;
}

/** The description after `<name>: `, "" for the bare name, or null when the call is not one of these tools. */
function subagentToolTitle(names: readonly string[], name: string): string | null {
  for (const tool of names) {
    if (name === tool) return "";
    if (name.startsWith(`${tool}: `)) return name.slice(tool.length + 2).trim();
  }
  return null;
}

/** The report or error in a tool result: a string, or the text field of an object. */
function resultText(rawOutput: unknown, content: unknown): string {
  if (isString(rawOutput)) return rawOutput;
  const field = isRecord(rawOutput) ? firstString(rawOutput, ["output", "result", "text", "error", "message"]) : null;
  return field ?? contentText(content);
}

/**
 * Applies an ACP tool call that runs a subagent, such as Kimi's `Agent`, Cline's `spawn_agent`, or
 * Hermes's `delegate_task`. These agents send no events of the subagent itself, so its card shows
 * the task, the state, and the report. A background call is not shown: no event says when it ends.
 */
export function foldAcpSubagentTool(
  state: SubagentState,
  turnId: string,
  names: readonly string[],
  call: AcpSubagentToolCall,
  now: string,
  parent?: SubagentModelPick,
): SubagentChange | null {
  const title = subagentToolTitle(names, call.name);
  const existing = subagentFor(state, call.id);
  const ended = call.status === "completed" || call.status === "failed";
  // A call that was not shown while it ran, such as Kimi's background call, is not shown at its end.
  if (!existing && (title === null || ended)) return null;
  // Kimi sends no `rawInput`: the content of a running call is its arguments, and at the end its result.
  const input = isRecord(call.rawInput) ? call.rawInput : ended ? null : jsonRecord(contentText(call.content));
  if (input?.run_in_background === true || input?.background === true)
    return existing ? dropSubagent(state, call.id) : null;
  const description = title || firstString(input, ["description", "title"]) || "";
  const prompt = firstString(input, ["prompt", "task", "goal"]);
  const agentType = firstString(input, ["subagent_type", "agent", "role"]);
  // Fork (FEATURES.md #78): these agents report no model of the subagent, so it is the model the
  // call names, else the parent's.
  const requested = acpRequestedModel(input);
  if (!existing)
    return startSubagent(state, turnId, {
      id: call.id,
      title: description,
      agentType,
      prompt,
      status: "running",
      startedAt: now,
      endedAt: null,
      steps: [],
      error: null,
      ...subagentModelFields(requested, parent),
    });
  // The arguments stream in, so a later update can name the task that the first one did not.
  let changed = false;
  if (existing.status === "running") {
    if (description && existing.title !== description) {
      existing.title = description;
      changed = true;
    }
    if (prompt && existing.prompt !== prompt) {
      existing.prompt = prompt;
      changed = true;
    }
    if (agentType && existing.agentType !== agentType) {
      existing.agentType = agentType;
      changed = true;
    }
    if (requested.model && existing.model !== requested.model) {
      existing.model = requested.model;
      changed = true;
    }
    if (requested.effort && existing.effort !== requested.effort) {
      existing.effort = requested.effort;
      changed = true;
    }
  }
  if (call.status === "completed") {
    pushSubagentReport(existing, resultText(call.rawOutput, call.content));
    changed = endSubagent(existing, "completed", now) || changed;
  } else if (call.status === "failed")
    changed = endSubagent(existing, "failed", now, resultText(call.rawOutput, call.content) || null) || changed;
  return changed ? subagentChange(state, state.turnOf.get(call.id)) : null;
}

/** Fork: the model and effort that a subagent call's arguments name, when they name one. */
function acpRequestedModel(input: DynamicRecord | null): { model: string | null; effort: string | null } {
  const model = firstString(input, ["model", "model_id", "modelId"]);
  return {
    model: model && model !== "inherit" ? model.trim() : null,
    effort: firstString(input, ["reasoning_effort", "reasoningEffort", "effort"])?.trim() ?? null,
  };
}

/** A subagent call that OpenCode's parent session made, which its child session takes the task of. */
interface OpenCodeLaunch {
  title: string;
  prompt: string | null;
  agentType: string | null;
  background: boolean;
  /** Fork (FEATURES.md #78): the model and effort the call named, if any. */
  model: string | null;
  effort: string | null;
}

/** The parent's `subagent` (`task` before OpenCode 2) calls that no child session took yet, by call id. */
export type OpenCodeLaunches = Map<string, OpenCodeLaunch>;

const OPENCODE_LAUNCH_LIMIT = 24;

/** The text that a streamed step keeps. A step shows 500 characters on one line. */
const OPENCODE_STREAM_LIMIT = 2_000;

/**
 * Notes a parent tool call that starts an OpenCode subagent. Its child session reports only the
 * description as its title, so the prompt and the agent come from this call.
 */
export function noteOpenCodeLaunch(launches: OpenCodeLaunches, call: AcpSubagentToolCall): void {
  const input = isRecord(call.rawInput) ? call.rawInput : null;
  const title = firstString(input, ["description"]);
  const prompt = firstString(input, ["prompt"]);
  if (!title || !prompt || isString(input?.sessionID)) return;
  launches.set(call.id, {
    title,
    prompt,
    agentType: firstString(input, ["agent", "subagent_type"]),
    background: input?.background === true,
    ...acpRequestedModel(input),
  });
  for (const id of launches.keys()) {
    if (launches.size <= OPENCODE_LAUNCH_LIMIT) break;
    launches.delete(id);
  }
}

/**
 * Marks the subagent background when the parent's call ended and left it running: OpenCode then
 * reports its end after the turn. The call's result names the child session.
 */
export function markOpenCodeBackground(state: SubagentState, rawOutput: unknown): SubagentChange | null {
  const metadata = isRecord(rawOutput) && isRecord(rawOutput.metadata) ? rawOutput.metadata : null;
  if (metadata?.status !== "running" || !isString(metadata.sessionID)) return null;
  const subagent = subagentFor(state, metadata.sessionID);
  if (!subagent || subagent.background || subagent.status !== "running") return null;
  subagent.background = true;
  return subagentChange(state, state.turnOf.get(subagent.id));
}

/** The step kind of an ACP tool kind. */
function acpStepKind(kind: unknown): ConversationSubagentStepKind {
  switch (kind) {
    case "read":
      return "read";
    case "search":
      return "search";
    case "edit":
    case "delete":
    case "move":
      return "edit";
    case "execute":
      return "command";
    case "fetch":
      return "web";
    case "think":
      return "thinking";
    default:
      return "tool";
  }
}

/**
 * Applies an `opencode/session/child_update` notification. `turnId` is the parent session's
 * running turn: a new child session belongs to it. A child of a child shows its steps in its top
 * subagent. Text and thinking stream; the list is sent when a step starts or the state changes, not
 * for each chunk.
 */
export function foldOpenCodeChildUpdate(
  state: SubagentState,
  launches: OpenCodeLaunches,
  turnId: string | null,
  params: unknown,
  now: string,
  parent?: SubagentModelPick,
): SubagentChange | null {
  if (!isRecord(params) || !isString(params.childSessionId)) return null;
  const childId = params.childSessionId;
  const nested = typeof params.depth === "number" && params.depth > 1;
  if (nested && isString(params.parentSessionId) && !state.aliases.has(childId)) {
    const top = state.aliases.get(params.parentSessionId) ?? params.parentSessionId;
    if (state.turnOf.has(top)) state.aliases.set(childId, top);
  }
  const id = state.aliases.get(childId) ?? childId;
  const childTitle = isString(params.title) ? params.title : "";
  const subagent = subagentFor(state, id);
  if (params.type === "status") {
    if (nested) return null;
    const status = params.status;
    if (status === "created" || status === "running") {
      if (subagent) {
        if (subagent.status === "running") return null;
        // The parent sent a follow-up to a subagent that had ended.
        subagent.status = "running";
        subagent.endedAt = null;
        subagent.error = null;
        return subagentChange(state, state.turnOf.get(id));
      }
      if (!turnId) return null;
      const launch = takeLaunch(launches, childTitle);
      return startSubagent(state, turnId, {
        id,
        title: childTitle,
        agentType: launch?.agentType ?? null,
        prompt: launch?.prompt ?? null,
        status: "running",
        startedAt: now,
        endedAt: null,
        steps: [],
        error: null,
        ...(launch?.background ? { background: true as const } : {}),
        ...subagentModelFields({ model: launch?.model, effort: launch?.effort }, parent),
      });
    }
    if (!subagent) return null;
    state.streams.delete(id);
    const error = isRecord(params.error) && isString(params.error.message) ? params.error.message : null;
    const ended =
      status === "completed"
        ? endSubagent(subagent, "completed", now)
        : status === "failed"
          ? endSubagent(subagent, "failed", now, error)
          : status === "interrupted"
            ? endSubagent(subagent, "stopped", now)
            : false;
    return ended ? subagentChange(state, state.turnOf.get(id)) : null;
  }
  if (params.type !== "update" || !subagent || subagent.status !== "running" || !isRecord(params.update)) return null;
  const update = params.update;
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    if (!isString(update.toolCallId)) return null;
    const previous = subagent.steps.find((step) => step.id === update.toolCallId);
    const input = isRecord(update.rawInput) ? update.rawInput : null;
    const title = isString(update.title) ? update.title : "";
    const target =
      firstString(input, ["command", "cmd", "filePath", "path", "pattern", "query", "url"]) ??
      (childTitle && title.startsWith(`${childTitle}: `) ? title.slice(childTitle.length + 2) : title);
    const kind = update.kind === undefined && previous ? previous.kind : acpStepKind(update.kind);
    const text = target || previous?.text || "";
    if (previous && previous.kind === kind && previous.text === text.trim()) return null;
    state.streams.get(id)?.clear();
    return pushSubagentStep(subagent, { id: update.toolCallId, kind, text })
      ? subagentChange(state, state.turnOf.get(id))
      : null;
  }
  return foldSubagentChunk(state, id, subagent, `${id}:`, update, now);
}

/**
 * Applies an ACP text or thinking chunk of a subagent's own session to its card. Text and thinking
 * stream; the list is sent when a step starts, not for each chunk. `prefix` keeps apart the streams
 * of sessions that share one card.
 */
function foldSubagentChunk(
  state: SubagentState,
  id: string,
  subagent: ConversationSubagent,
  prefix: string,
  update: DynamicRecord,
  now: string,
): SubagentChange | null {
  const kind =
    update.sessionUpdate === "agent_message_chunk"
      ? "text"
      : update.sessionUpdate === "agent_thought_chunk"
        ? "thinking"
        : null;
  const chunk = isRecord(update.content) && isString(update.content.text) ? update.content.text : "";
  if (!kind || !chunk) return null;
  const streams = state.streams.get(id) ?? new Map<string, string>();
  state.streams.set(id, streams);
  // Without a message id, a chunk continues the open step of its kind. A tool call closes it.
  const kindPrefix = `${prefix}${kind}:`;
  const stepId = isString(update.messageId)
    ? `${kindPrefix}${update.messageId}`
    : ([...streams.keys()].find((key) => key.startsWith(kindPrefix)) ?? `${kindPrefix}${now}`);
  const previous = streams.get(stepId) ?? "";
  // A step shows only the start of its text, so a long stream stops growing.
  if (previous.length >= OPENCODE_STREAM_LIMIT) return null;
  streams.set(stepId, previous + chunk);
  const started = !subagent.steps.some((step) => step.id === stepId);
  const pushed = pushSubagentStep(subagent, { id: stepId, kind, text: previous + chunk });
  return pushed && started ? subagentChange(state, state.turnOf.get(id)) : null;
}

/** Fork (FEATURES.md #90): the card id of the `index`th of the `count` subagents that a call starts. */
function sessionSubagentId(callId: string, index: number, count: number): string {
  return count === 1 ? callId : `${callId}:${index}`;
}

/** Fork (FEATURES.md #90): the cards of the subagents that the call `callId` started. */
function sessionSubagentCards(state: SubagentState, callId: string): ConversationSubagent[] {
  return [...state.turns.values()]
    .flatMap((turn) => turn.subagents)
    .filter((subagent) => subagent.id === callId || subagent.id.startsWith(`${callId}:`));
}

/**
 * Fork (FEATURES.md #90): applies a call that starts subagents that run as sessions of their own
 * (`AcpFlavor.subagentSessions`), such as Antigravity's `invoke_subagent`. The call completes at once
 * and each subagent works on after it, also after the turn, so each card is a background subagent
 * that runs until it reports, is stopped, or its session ends. A failed call starts none.
 */
export function foldSessionSubagentCall(
  state: SubagentState,
  turnId: string,
  call: AcpSubagentToolCall,
  launches: readonly AcpSubagentLaunch[],
  now: string,
  parent?: SubagentModelPick,
): SubagentChange | null {
  let change: SubagentChange | null = null;
  for (const [index, launch] of launches.entries()) {
    const id = sessionSubagentId(call.id, index, launches.length);
    const existing = subagentFor(state, id);
    if (!existing) {
      if (call.status === "failed") continue;
      change =
        startSubagent(state, turnId, {
          id,
          title: launch.title,
          agentType: launch.agentType,
          prompt: launch.prompt,
          status: "running",
          startedAt: now,
          endedAt: null,
          steps: [],
          error: null,
          background: true,
          ...subagentModelFields({ model: launch.model }, parent),
        }) ?? change;
    } else if (
      call.status === "failed" &&
      endSubagent(existing, "failed", now, resultText(call.rawOutput, call.content) || null)
    )
      change = subagentChange(state, state.turnOf.get(id)) ?? change;
  }
  return change;
}

/**
 * Fork (FEATURES.md #90): ties the session of a subagent that the call `callId` of session
 * `parentId` started to its card: the card with the same task, else the first card of the call with
 * no session. A subagent of a subagent shows its work in the card of its top subagent. Returns false
 * when there is no card for it.
 */
export function linkSessionSubagent(
  state: SubagentState,
  callId: string,
  parentId: string,
  session: { id: string; prompt: string | null },
): boolean {
  const top = state.aliases.get(parentId);
  if (top !== undefined) {
    state.aliases.set(session.id, top);
    return true;
  }
  const linked = new Set(state.aliases.values());
  const free = sessionSubagentCards(state, callId).filter((card) => !linked.has(card.id));
  const prompt = session.prompt?.trim();
  const card = free.find((candidate) => prompt && candidate.prompt?.trim() === prompt) ?? free[0];
  if (!card) return false;
  state.aliases.set(session.id, card.id);
  return true;
}

/**
 * Fork (FEATURES.md #90): ends the cards of the call `callId` that got no session. OpenBot then can
 * neither answer the subagent's approvals nor follow its work, and the agent's own approval wait
 * fails its commands (FEATURES.md #84).
 */
export function failUnlinkedSessionSubagents(
  state: SubagentState,
  callId: string,
  now: string,
  error: string,
): SubagentChange | null {
  const linked = new Set(state.aliases.values());
  let change: SubagentChange | null = null;
  for (const card of sessionSubagentCards(state, callId))
    if (!linked.has(card.id) && endSubagent(card, "failed", now, error))
      change = subagentChange(state, state.turnOf.get(card.id)) ?? change;
  return change;
}

/** Fork (FEATURES.md #90): ends the cards of the subagent sessions that the agent stopped. */
export function stopSessionSubagents(
  state: SubagentState,
  sessionIds: readonly string[],
  now: string,
): SubagentChange[] {
  const turnIds = new Set<string>();
  for (const sessionId of sessionIds) {
    const id = state.aliases.get(sessionId);
    const card = id === undefined ? undefined : subagentFor(state, id);
    if (id !== undefined && card && endSubagent(card, "stopped", now)) {
      state.streams.delete(id);
      const turnId = state.turnOf.get(id);
      if (turnId) turnIds.add(turnId);
    }
  }
  return [...turnIds].flatMap((turnId) => subagentChange(state, turnId) ?? []);
}

/** Fork (FEATURES.md #90): the argument that a step of a subagent session shows, before the call's title. */
const SESSION_STEP_FIELDS = ["CommandLine", "Path", "AbsolutePath", "TargetFile", "Url", "Query", "command", "path"];

/**
 * Fork (FEATURES.md #90): applies an update of a subagent's own session, which OpenBot resumed on its
 * parent's connection (`AcpFlavor.subagentSessions`), to the subagent's card: its tool calls, text
 * and thinking are its steps. `report` reads a call that reports to a session; a report to `ownerId`,
 * the session of the agent that started the subagent, ends the card with the report as its last
 * step. A report of a nested subagent to its own parent is a step. A new tool call after the report
 * runs the card again.
 */
export function foldSessionSubagentUpdate(
  state: SubagentState,
  sessionId: string,
  ownerId: string,
  update: unknown,
  report: (name: string, input: unknown) => { to: string; text: string } | null,
  now: string,
): SubagentChange | null {
  const id = state.aliases.get(sessionId);
  const subagent = id === undefined ? undefined : subagentFor(state, id);
  if (id === undefined || !subagent || !isRecord(update)) return null;
  const turnId = state.turnOf.get(id);
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update")
    return subagent.status === "running" ? foldSubagentChunk(state, id, subagent, `${sessionId}:`, update, now) : null;
  if (!isString(update.toolCallId)) return null;
  const title = isString(update.title) ? update.title : "";
  const name = isString(update.name) ? update.name : title;
  const input = isRecord(update.rawInput) ? update.rawInput : null;
  const sent = report(name, input);
  if (sent?.to === ownerId) {
    if (update.status !== "completed" || subagent.status !== "running") return null;
    state.streams.delete(id);
    pushSubagentReport(subagent, sent.text);
    endSubagent(subagent, "completed", now);
    return subagentChange(state, turnId);
  }
  let reopened = false;
  if (subagent.status !== "running") {
    if (update.sessionUpdate !== "tool_call") return null;
    subagent.status = "running";
    subagent.endedAt = null;
    subagent.error = null;
    reopened = true;
  }
  const previous = subagent.steps.find((step) => step.id === update.toolCallId);
  const kind = update.kind === undefined && previous ? previous.kind : acpStepKind(update.kind);
  const text = firstString(input, SESSION_STEP_FIELDS) ?? (title || name || previous?.text || "");
  if (!reopened && previous && previous.kind === kind && previous.text === text.trim()) return null;
  state.streams.get(id)?.clear();
  const pushed = pushSubagentStep(subagent, { id: update.toolCallId, kind, text });
  return pushed || reopened ? subagentChange(state, turnId) : null;
}

/** The launch whose description is the child session's title, which it then leaves the list. */
function takeLaunch(launches: OpenCodeLaunches, title: string): OpenCodeLaunch | undefined {
  for (const [callId, launch] of launches)
    if (launch.title === title) {
      launches.delete(callId);
      return launch;
    }
  return undefined;
}
