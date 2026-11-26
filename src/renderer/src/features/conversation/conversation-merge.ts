import type { ConversationMessage, ConversationPage } from "@openbot/contracts/ipc";
import type { AgentMessage } from "@openbot/ui/data";
import {
  placeTurnStepRows,
  retainThinkingMessages,
  turnCoverage,
  withUnreachedTurnSteps,
} from "../../app-message-projection";

export type ConversationPageMerge = "replace" | "older" | "latest";

export function mergeConversationPage<Message extends { id: string; kind?: string | undefined }>(
  loaded: readonly Message[],
  page: readonly Message[],
  merge: ConversationPageMerge,
): Message[] {
  if (merge === "replace") return [...page];
  const pageIds = new Set(page.map((message) => message.id));
  if (merge === "latest") {
    // Fork #121: a turn's steps row stands at the turn's first step, so a page that holds only the end of
    // a turn (#119) does not start there. The page starts at its first other shared row, and the loaded
    // rows before that stay, the user's steers early in the turn too. The caller places the steps row.
    const firstShared = loaded.findIndex((message) => message.kind !== "thinking" && pageIds.has(message.id));
    if (firstShared !== -1)
      return [...loaded.slice(0, firstShared).filter((message) => !pageIds.has(message.id)), ...page];
  }
  const kept = loaded.filter((message) => !pageIds.has(message.id));
  return merge === "older" ? [...page, ...kept] : [...kept, ...page];
}

function mergeOlderPage<Message extends { id: string; kind?: string | undefined }>(
  loaded: readonly Message[],
  page: readonly Message[],
): Message[] {
  const pageById = new Map(page.map((message) => [message.id, message]));
  const result = loaded.map((message) => pageById.get(message.id) ?? message);
  const index = new Map(result.map((message, position) => [message.id, position]));
  const shared = page.filter((message) => message.kind !== "thinking" && index.has(message.id));
  if (shared.length === 0) return [...page, ...loaded.filter((message) => !pageById.has(message.id))];
  const lastShared = Math.max(...shared.map((message) => index.get(message.id) ?? -1));
  let anchor = lastShared + 1;
  const inserts: { at: number; message: Message }[] = [];
  for (const message of [...page].reverse()) {
    const position = index.get(message.id);
    if (position === undefined) inserts.push({ at: anchor, message });
    else if (message.kind !== "thinking") anchor = Math.min(anchor, position);
  }
  const merged = [...result];
  inserts.sort((left, right) => right.at - left.at);
  for (const { at, message } of inserts) merged.splice(at, 0, message);
  return merged;
}

export function missingReplyOriginals(page: Pick<ConversationPage, "messages" | "references">): Record<string, true> {
  const pageIds = new Set(page.messages.map((message) => message.id));
  const missing: Record<string, true> = {};
  for (const { replyToMessageId } of page.messages) {
    if (replyToMessageId && !pageIds.has(replyToMessageId) && !(replyToMessageId in page.references)) {
      missing[replyToMessageId] = true;
    }
  }
  return missing;
}

export function windowedSnapshotMessages<
  Message extends { id: string; turnId?: string | undefined; kind?: string | undefined },
>(
  loaded: readonly Message[],
  snapshot: readonly Message[],
  window: { mode: "latest" | "around"; capped: boolean },
): Message[] {
  if (!window.capped) return [...snapshot];
  const snapshotIds = new Set(snapshot.map((message) => message.id));
  // Fork (docs/fork/FEATURES.md, "Replies stay in a long turn"): a turn's steps row is not a message of
  // the thread. A snapshot that holds only the end of a turn has a steps row for that end too, so the
  // row did not show where the snapshot starts, and the start of the turn that the chat had loaded went.
  const firstMessage = loaded.findIndex((message) => message.kind !== "thinking" && snapshotIds.has(message.id));
  const firstShared = firstMessage >= 0 ? firstMessage : loaded.findIndex((message) => snapshotIds.has(message.id));
  if (window.mode === "latest" && firstShared === -1) return [...snapshot];
  const older = loaded.slice(0, firstShared === -1 ? loaded.length : firstShared);
  let tail: Message[];
  if (window.mode === "around") {
    const loadedIds = new Set(loaded.map((message) => message.id));
    tail = snapshot.filter((message) => loadedIds.has(message.id));
  } else {
    const firstSharedId = loaded[firstShared]?.id;
    let start = snapshot.findIndex((message) => message.id === firstSharedId);
    // Fork ("Replies stay in a long turn"): the window starts with the whole turn of its first shared
    // message. A turn's steps row stands where the turn's first step is, so a window that started at
    // a later message of the turn cut the row off, with every reply of the turn in it.
    const turnId = snapshot[start]?.turnId;
    if (turnId) while (start > 0 && snapshot[start - 1]?.turnId === turnId) start -= 1;
    tail = snapshot.slice(start);
  }
  // A steps row that the loaded part holds keeps its place, with the snapshot's copy.
  const tailById = new Map(tail.map((message) => [message.id, message]));
  const kept = older.map((message) => tailById.get(message.id) ?? message);
  const keptIds = new Set(kept.map((message) => message.id));
  return [...kept, ...tail.filter((message) => !keptIds.has(message.id))];
}

/**
 * Fork ("Replies stay in a long turn"). Whether a latest page meets the loaded messages, so the two
 * join with no messages between them that the chat would not show. A latest page holds whole turns
 * up to 50 messages, and only one part of a turn of more than 100, so after a long turn it can hold
 * one message, such as a queued request that the chat does not show. The page meets them when they
 * share a message, when it shows nothing, when it starts before the last loaded message, or when the
 * loaded messages are already at the page's revision.
 */
type MergedRow = { id: string; createdAt?: string | undefined; itemIds?: readonly string[] | undefined };

export function pageMeetsLoaded(
  loaded: readonly MergedRow[],
  page: Pick<ConversationPage, "messages" | "revision">,
  pageMessages: readonly MergedRow[],
  loadedRevision: number | undefined,
): boolean {
  if (loaded.length === 0) return false;
  if (pageMessages.length === 0) return true;
  if (loadedRevision !== undefined && loadedRevision >= page.revision) return true;
  const loadedIds = new Set(loaded.flatMap((message) => [message.id, ...(message.itemIds ?? [])]));
  if (page.messages.some((message) => loadedIds.has(message.id))) return true;
  if (pageMessages.some((message) => loadedIds.has(message.id))) return true;
  const pageStart = page.messages.reduce<string | undefined>(
    (first, message) => (message.createdAt && (!first || message.createdAt < first) ? message.createdAt : first),
    undefined,
  );
  const loadedEnd = loaded.reduce<string | undefined>(
    (last, message) => (message.createdAt && (!last || message.createdAt > last) ? message.createdAt : last),
    undefined,
  );
  return pageStart !== undefined && loadedEnd !== undefined && pageStart <= loadedEnd;
}

/**
 * Fork ("Replies stay in a long turn"). The rows of an agent chat after a snapshot: the snapshot's
 * rows in the chat's window, with the steps rows that the snapshot holds only a part of kept whole.
 * `whole` is a snapshot that holds the whole chat. Pure, so a test can run each step of a stream.
 */
export function snapshotRows(
  previous: readonly AgentMessage[],
  mapped: AgentMessage[],
  source: readonly ConversationMessage[],
  options: { mode: "latest" | "around"; capped: boolean; whole: boolean; activeTurnId: string | null },
): AgentMessage[] {
  const windowed = retainThinkingMessages(
    [...previous],
    windowedSnapshotMessages(previous, mapped, { mode: options.mode, capped: options.capped }),
    options.activeTurnId,
  );
  if (options.whole) return placeTurnStepRows(windowed);
  const coverage = turnCoverage(source);
  const previousById = new Map(previous.map((message) => [message.id, message]));
  return placeTurnStepRows(
    windowed.map((incoming) => withUnreachedTurnSteps(previousById.get(incoming.id), incoming, coverage)),
  );
}

/**
 * Fork ("Replies stay in a long turn"). The rows of a page, each with the loaded items of a turn
 * that the page holds only a part of.
 */
export function pageRows(
  loaded: readonly AgentMessage[],
  mapped: readonly AgentMessage[],
  source: readonly ConversationMessage[],
) {
  const coverage = turnCoverage(source);
  const loadedById = new Map(loaded.map((message) => [message.id, message]));
  return mapped.map((message) => withUnreachedTurnSteps(loadedById.get(message.id), message, coverage));
}

/**
 * The rows of an agent chat after a page, and where its cursor of older pages comes from. `pageMessages`
 * are the rows of `pageRows`, as the caller keeps them. Pure, so a test can run each step of a stream.
 */
export function pageWindow(
  loaded: readonly AgentMessage[],
  pageMessages: readonly AgentMessage[],
  page: Pick<ConversationPage, "messages" | "pageInfo" | "revision">,
  options: {
    requestedMerge: ConversationPageMerge;
    windowMode: "latest" | "around" | undefined;
    loadedWindowMode: "latest" | "around" | undefined;
    loadedRevision: number | undefined;
    trimmed: boolean;
  },
): { messages: AgentMessage[]; merge: ConversationPageMerge; keepsWindow: boolean; keepsOlder: boolean } {
  const meets = pageMeetsLoaded(loaded, page, pageMessages, options.loadedRevision);
  // Fork ("Replies stay in a long turn"): a latest page that meets the loaded latest window joins it,
  // as on the web client and the phone. Each change of the agent's state reads that page, and a page
  // that held only the end of a long turn replaced the chat: the turn's replies went until a later
  // page or snapshot put them back (23 Nov 2026).
  const merge =
    options.requestedMerge === "replace" &&
    options.windowMode === "latest" &&
    options.loadedWindowMode !== "around" &&
    meets
      ? "latest"
      : options.requestedMerge;
  // A delta that came before this page can show a commentary item as its own message. The page
  // groups that item under its turn's thinking message, so the loaded copy goes.
  const pageItemIds = new Set(page.messages.map((message) => message.id));
  // A latest page is the end of the thread. The loaded messages can reach further back, and
  // their cursor of the older pages stays. Two cases must not join end to end, because the
  // messages between would be out of view with no sign: a window around an old message keeps
  // its place, and loaded messages that the page does not meet give way to the page.
  const mappedIds = new Set(pageMessages.map((message) => message.id));
  // A chat with no page yet, or a trimmed one, has no cursor of its own, so it takes the page's.
  const tail = merge === "latest" && page.pageInfo.hasOlder && !options.trimmed;
  const keepsWindow = tail && options.loadedWindowMode === "around";
  const apart = tail && !keepsWindow && !meets;
  // The loaded copies of the page's messages that the page groups into a steps row go.
  const kept = loaded.filter((message) => mappedIds.has(message.id) || !pageItemIds.has(message.id));
  const messages = placeTurnStepRows(
    keepsWindow
      ? windowedSnapshotMessages(loaded, pageMessages, { mode: "around", capped: true }).filter(
          (message) => mappedIds.has(message.id) || !pageItemIds.has(message.id),
        )
      : merge === "older"
        ? mergeOlderPage(kept, pageMessages)
        : mergeConversationPage(kept, pageMessages, apart ? "replace" : merge),
  );
  const first = messages[0];
  // The loaded messages start before the page, so the cursor of the older pages is still theirs.
  // A window that starts in the page dropped the page's messages before it, so it keeps its cursor too.
  const keepsOlder = keepsWindow || (tail && first !== undefined && !mappedIds.has(first.id));
  return { messages, merge, keepsWindow, keepsOlder };
}
