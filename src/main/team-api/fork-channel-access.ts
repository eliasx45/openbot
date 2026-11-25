import { posix } from "node:path";
import type { AgentAccessLevel, AgentEvent, ChannelAccessLevel } from "@openbot/contracts/ipc";
import { CHAT_HISTORY_ROUTES } from "@openbot/contracts/team-protocol/chat-history-v1";
import { MESSAGE_DELETE_ROUTES } from "@openbot/contracts/team-protocol/message-delete-v1";
import { PENDING_APPROVAL_ROUTES } from "@openbot/contracts/team-protocol/pending-approval-v1";
import { PENDING_PROMPTS_ROUTES } from "@openbot/contracts/team-protocol/pending-prompts-v1";
import { ROUTINES_ONCE_ROUTES } from "@openbot/contracts/team-protocol/routines-once-v1";
import { STORAGE_CHANNEL_ROUTES } from "@openbot/contracts/team-protocol/storage-channel-v1";
import { PHONE_COPY_PREFIX } from "../fork-phone-video";

const CHANNEL_SCOPED_ROUTES: ReadonlySet<string> = new Set([
  STORAGE_CHANNEL_ROUTES.files,
  PENDING_PROMPTS_ROUTES.list,
  PENDING_APPROVAL_ROUTES.read,
  CHAT_HISTORY_ROUTES.channelClear,
  CHAT_HISTORY_ROUTES.channelCompact,
  CHAT_HISTORY_ROUTES.channelDelete,
  MESSAGE_DELETE_ROUTES.channel,
  ...Object.values(ROUTINES_ONCE_ROUTES),
]);

export function forkChannelRoute(pathname: string): boolean {
  return pathname === "/v1/channels" || pathname.startsWith("/v1/channels/") || CHANNEL_SCOPED_ROUTES.has(pathname);
}

export type ForkAttachmentScope =
  | { draft: true }
  | { draft: false; agentIds: string[]; channelId: string | null; threadId: string | null }
  | null;

export interface ForkAttachmentAccess {
  scope: (attachmentId: string) => ForkAttachmentScope;
  agentLevel: (agentId: string) => AgentAccessLevel;
  channelLevel: (channelId: string) => ChannelAccessLevel;
  channelForThread: (threadId: string) => string | null;
  channelIds: () => readonly string[];
  channelHasAttachment: (channelId: string, attachmentId: string) => boolean;
}

export function forkAttachmentAllowed(attachmentId: string, access: ForkAttachmentAccess): boolean {
  const sourceId = attachmentId.startsWith(PHONE_COPY_PREFIX)
    ? attachmentId.slice(PHONE_COPY_PREFIX.length)
    : attachmentId;
  const scope = access.scope(sourceId);
  if (scope === null || scope.draft) return true;
  if (scope.agentIds.some((agentId) => access.agentLevel(agentId) !== "none")) return true;
  if (scope.channelId !== null && access.channelLevel(scope.channelId) !== "none") return true;
  const threadChannel = scope.threadId === null ? null : access.channelForThread(scope.threadId);
  if (threadChannel !== null && access.channelLevel(threadChannel) !== "none") return true;
  return access
    .channelIds()
    .some((channelId) => access.channelLevel(channelId) !== "none" && access.channelHasAttachment(channelId, sourceId));
}

export function forkChannelEventId(event: AgentEvent): string | null {
  if (
    event.type === "channels-changed" ||
    event.type === "channel-memories-changed" ||
    event.type === "channel-routines-changed"
  )
    return event.channelId;
  return null;
}

// Fork (docs/fork/FEATURES.md #107): a member who sees no agent opens a file of the shared folder only when
// a message of a channel they see names it as `Shared/<path>` (also `~/OpenBot/Shared/…` or an absolute path).
export function forkSharedFileMention(requestedPath: string): string | null {
  const written = requestedPath.trim().replaceAll("\\", "/");
  const marker = written.lastIndexOf("/OpenBot/Shared/");
  let relativePath = marker >= 0 ? written.slice(marker + "/OpenBot/Shared/".length) : written;
  for (const prefix of ["~/OpenBot/Shared/", "OpenBot/Shared/", "Shared/"])
    if (relativePath.startsWith(prefix)) relativePath = relativePath.slice(prefix.length);
  if (relativePath.startsWith("/") || relativePath.length === 0) return null;
  if (posix.normalize(relativePath) !== relativePath || relativePath.startsWith("..")) return null;
  return `Shared/${relativePath}`;
}

export function forkSharedFileMentioned(mention: string, texts: Iterable<string>): boolean {
  const encoded = encodeURI(mention);
  for (const text of texts) if (text.includes(mention) || text.includes(encoded)) return true;
  return false;
}
