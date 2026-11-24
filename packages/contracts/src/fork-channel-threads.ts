import type { ChannelMessage, ChannelTask } from "./ipc-chat-channels";
import { CHANNEL_CHANGE_ITEM_TYPE, CONTEXT_RESET_ITEM_TYPE } from "./ipc-conversation-events";
import { CONVERSATION_MEMORY_CHANGES_ITEM_TYPE } from "./ipc-conversation-memory-changes";
import { CONVERSATION_PLAN_ITEM_TYPE } from "./ipc-conversation-plan";
import { CONVERSATION_SUBAGENTS_ITEM_TYPE } from "./ipc-conversation-subagents";

export const CHANNEL_THREAD_REPLIER_LIMIT = 3;

export interface ChannelThreadSummary {
  rootId: string;
  replies: number;
  lastReplyAt: string | null;
  repliers: ChannelMessage["author"][];
}

export interface ChannelThreads {
  roots: ChannelMessage[];
  rootOf: ReadonlyMap<string, string>;
  summaries: ReadonlyMap<string, ChannelThreadSummary>;
}

const NON_LINE_ITEM_TYPES: ReadonlySet<string> = new Set([
  "commentary",
  CONVERSATION_PLAN_ITEM_TYPE,
  CONVERSATION_SUBAGENTS_ITEM_TYPE,
  CONVERSATION_MEMORY_CHANGES_ITEM_TYPE,
  CHANNEL_CHANGE_ITEM_TYPE,
  CONTEXT_RESET_ITEM_TYPE,
]);

function deletedEntry(entry: ChannelMessage): boolean {
  return "deleted" in entry && entry.deleted === true;
}

function hasContent(entry: ChannelMessage): boolean {
  const message = entry.message;
  return Boolean(message.text.trim() || message.attachments?.length || message.questionPrompt);
}

export function channelConversationLine(entry: ChannelMessage): boolean {
  if (deletedEntry(entry) || !hasContent(entry)) return false;
  if (entry.author.kind === "member") return true;
  if (entry.author.kind !== "agent" || entry.message.author !== "assistant") return false;
  const itemType = entry.message.itemType ?? "";
  return !NON_LINE_ITEM_TYPES.has(itemType) && !itemType.includes(":");
}

function taskRequests(task: ChannelTask, tasks: ReadonlyMap<string, ChannelTask>): string[] {
  const root = tasks.get(task.rootTaskId) ?? task;
  return [
    ...new Set([...task.sourceMessageIds, task.requestMessageId, ...root.sourceMessageIds, root.requestMessageId]),
  ];
}

export function channelThreadParentId(
  entry: ChannelMessage,
  byId: ReadonlyMap<string, ChannelMessage>,
  tasks: ReadonlyMap<string, ChannelTask>,
): string | null {
  const reply = entry.message.replyToMessageId ?? null;
  if (reply && entry.message.author !== "system") return reply;
  return taskParentId(entry, byId, tasks) ?? reply;
}

function taskParentId(
  entry: ChannelMessage,
  byId: ReadonlyMap<string, ChannelMessage>,
  tasks: ReadonlyMap<string, ChannelTask>,
): string | null {
  if (entry.author.kind === "member" || !entry.taskId) return null;
  const task = tasks.get(entry.taskId);
  if (!task) return null;
  let parent: ChannelMessage | undefined;
  for (const id of taskRequests(task, tasks)) {
    const request = byId.get(id);
    if (!request || request.id === entry.id || request.author.kind !== "member") continue;
    if (request.sequence >= entry.sequence) continue;
    if (!parent || request.sequence > parent.sequence) parent = request;
  }
  return parent?.id ?? null;
}

export function channelThreadRoots(
  entries: readonly ChannelMessage[],
  tasks: readonly ChannelTask[],
): ReadonlyMap<string, string> {
  const byId = new Map(entries.map((entry) => [entry.id, entry] as const));
  const tasksById = new Map(tasks.map((task) => [task.id, task] as const));
  const parents = new Map<string, string | null>();
  for (const entry of entries) parents.set(entry.id, channelThreadParentId(entry, byId, tasksById));
  const rootOf = new Map<string, string>();
  for (const entry of entries) {
    if (rootOf.has(entry.id)) continue;
    const path: string[] = [];
    const onPath = new Set<string>();
    let current = entry.id;
    let root = current;
    for (;;) {
      const known = rootOf.get(current);
      if (known !== undefined) {
        root = known;
        break;
      }
      if (onPath.has(current)) {
        root = oldestOf(path.slice(path.indexOf(current)), byId);
        break;
      }
      onPath.add(current);
      path.push(current);
      const parent = parents.get(current) ?? null;
      const found = parent === null ? undefined : byId.get(parent);
      if (!found || deletedEntry(found)) {
        root = current;
        break;
      }
      current = found.id;
    }
    for (const id of path) rootOf.set(id, root);
  }
  return rootOf;
}

function oldestOf(ids: readonly string[], byId: ReadonlyMap<string, ChannelMessage>): string {
  let oldest = ids[0] ?? "";
  for (const id of ids) {
    const sequence = byId.get(id)?.sequence ?? Number.POSITIVE_INFINITY;
    if (sequence < (byId.get(oldest)?.sequence ?? Number.POSITIVE_INFINITY)) oldest = id;
  }
  return oldest;
}

function authorKey(author: ChannelMessage["author"]): string {
  return `${author.kind}:${author.id}`;
}

export function channelThreads(entries: readonly ChannelMessage[], tasks: readonly ChannelTask[]): ChannelThreads {
  const ordered = [...entries].sort((left, right) => left.sequence - right.sequence);
  const rootOf = channelThreadRoots(ordered, tasks);
  const roots = ordered.filter((entry) => rootOf.get(entry.id) === entry.id && channelConversationLine(entry));
  const summaries = new Map<string, ChannelThreadSummary>(
    roots.map((root) => [root.id, { rootId: root.id, replies: 0, lastReplyAt: null, repliers: [] }]),
  );
  const seen = new Map<string, Set<string>>();
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const entry = ordered[index];
    if (!entry || !channelConversationLine(entry)) continue;
    const rootId = rootOf.get(entry.id);
    if (rootId === undefined || rootId === entry.id) continue;
    const summary = summaries.get(rootId);
    if (!summary) continue;
    summary.replies += 1;
    const at = entry.message.createdAt;
    if (summary.lastReplyAt === null || Date.parse(at) > Date.parse(summary.lastReplyAt)) summary.lastReplyAt = at;
    const repliers = seen.get(rootId) ?? new Set<string>();
    seen.set(rootId, repliers);
    const key = authorKey(entry.author);
    if (repliers.has(key) || summary.repliers.length >= CHANNEL_THREAD_REPLIER_LIMIT) continue;
    repliers.add(key);
    summary.repliers.push(entry.author);
  }
  return { roots, rootOf, summaries };
}

export function channelThreadEntryIds(rootId: string, rootOf: ReadonlyMap<string, string>): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const [id, root] of rootOf) if (root === rootId) ids.add(id);
  return ids;
}
