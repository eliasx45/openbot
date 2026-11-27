import { feedbackSentIssue } from "@openbot/contracts/feedback";
import { serverInstallEvent } from "@openbot/contracts/hosted-servers";
import type {
  ClientAgentSummary,
  ConversationMessage,
  ConversationSearchPage,
  QueueDeliveryStatus,
} from "@openbot/contracts/ipc";
import {
  AGENT_INSTRUCTIONS_CHANGE_ITEM_TYPE,
  AGENT_WELCOME_ITEM_TYPE,
  CHANNEL_RESUME_ITEM_TYPE,
  CONVERSATION_MEMORY_CHANGES_ITEM_TYPE,
  CONVERSATION_PLAN_ITEM_TYPE,
  CONVERSATION_SUBAGENTS_ITEM_TYPE,
  hostedSiteConversationEvent,
  isChannelChangeMarker,
  isContextResetMarker,
  isPlanContinuationMarker,
  isVaultChangeMarker,
  marketplaceSuggestionEvent,
  mcpSignInEvent,
  modelSwitchReason,
  parseConversationPlanText,
  replacedConversationPlans,
  routineConversationEvent,
  routineRunConversationEvent,
  settingLinkEvent,
  signInFailureProvider,
  skillConversationEvent,
  skillSuggestionEvent,
} from "@openbot/contracts/ipc";
import { markdownPreviewText } from "@openbot/contracts/markdown-preview-text";
import { sourceText as englishSourceText } from "@openbot/i18n/source";
import { cleanAgentMessageText } from "@openbot/team-client/agent-message-text";
import type {
  AgentDeliveryMarkerStatus,
  AgentMessage,
  AgentMessagePlan,
  AgentProfile,
  ChatActionMarkerModel,
  ComposerThreadMessageMatch,
} from "@openbot/ui/data";
import { formatChatTimestamp } from "@openbot/ui/features/conversation/chat-timestamp";
import type { TaskListItem } from "@openbot/ui/features/conversation/TaskList";
import { currentText } from "@openbot/ui/text";
import { isRoutineEventItem } from "./features/conversation/conversation-read-state";

function feedbackSentTitle(text: string): string {
  for (const key of ["status.agent.feedbackSent", "status.agent.feedbackWithdrawn"] as const) {
    const prefix = englishSourceText(key, { title: "" });
    if (text.startsWith(prefix)) return text.slice(prefix.length);
  }
  return "";
}

export function toAgentProfile(stored: ClientAgentSummary): AgentProfile {
  return {
    id: stored.id,
    name: stored.name,
    title: stored.title,
    description: stored.description,
    notifications: stored.notifications,
    provider: stored.provider,
    model: stored.model,
    reasoningEffort: stored.reasoningEffort,
    ...(stored.providerAccountId === undefined ? {} : { providerAccountId: stored.providerAccountId }),
    ...(stored.access === undefined ? {} : { access: stored.access }),
    ...(stored.computerUse === undefined ? {} : { computerUse: stored.computerUse }),
    ...(stored.allowAutomation === undefined ? {} : { allowAutomation: stored.allowAutomation }),
    ...(stored.allowNewChat === undefined ? {} : { allowNewChat: stored.allowNewChat }),
    ...(stored.quickAcknowledgement === undefined ? {} : { quickAcknowledgement: stored.quickAcknowledgement }),
    ...(stored.memory === undefined ? {} : { memory: stored.memory }),
    ...(stored.fastMode === undefined ? {} : { fastMode: stored.fastMode }),
    ...(stored.ultrafast === undefined ? {} : { ultrafast: stored.ultrafast }),
    ...(stored.ownBrowserSession === undefined ? {} : { ownBrowserSession: stored.ownBrowserSession }),
    ...(stored.browserProfileId === undefined ? {} : { browserProfileId: stored.browserProfileId }),
    ...(stored.busyMessageMode === undefined ? {} : { busyMessageMode: stored.busyMessageMode }),
    ...(stored.taskLimit === undefined ? {} : { taskLimit: stored.taskLimit }),
    ...(stored.backupModels === undefined ? {} : { backupModels: stored.backupModels }),
    ...(stored.additionalFolders === undefined ? {} : { additionalFolders: stored.additionalFolders }),
    ...(stored.excludedFolders === undefined ? {} : { excludedFolders: stored.excludedFolders }),
    ...(stored.usageLimitReturn === undefined ? {} : { usageLimitReturn: stored.usageLimitReturn }),
    ...(stored.pendingRuntime === undefined ? {} : { pendingRuntime: stored.pendingRuntime }),
    threadId: stored.threadId,
    workspacePath: stored.workspacePath,
    avatarSeed: stored.avatarSeed,
    avatarHue: stored.avatarHue,
    ...(stored.avatarColor == null ? {} : { avatarColor: stored.avatarColor }),
    ...(stored.chatColor === undefined ? {} : { chatColor: stored.chatColor }),
    avatarUrl: stored.avatarUrl,
    ...(stored.marketplaceSource === undefined ? {} : { marketplaceSource: stored.marketplaceSource }),
    updatedAt: stored.updatedAt,
    time: stored.updatedAt ? formatTime(stored.updatedAt) : currentText().t("chat.day.now"),
    preview: cleanPreview(stored.preview),
  };
}

function conversationMessageBody(message: ConversationMessage): string {
  return message.author === "user" ? message.text : cleanAgentMessageText(message.text);
}

const THREAD_MESSAGE_SEARCH_PAGES = 3;
const THREAD_MESSAGE_SEARCH_THREADS = 10;

export async function collectThreadMessageMatches(
  readPage: (cursor: string | undefined) => Promise<ConversationSearchPage>,
): Promise<ComposerThreadMessageMatch[]> {
  const matches: ComposerThreadMessageMatch[] = [];
  const threads = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < THREAD_MESSAGE_SEARCH_PAGES; page += 1) {
    const result = await readPage(cursor);
    for (const { taskId, message } of result.results) {
      if (!taskId) continue;
      threads.add(taskId);
      matches.push({ threadId: taskId, body: conversationMessageBody(message) });
    }
    if (!result.nextCursor || threads.size >= THREAD_MESSAGE_SEARCH_THREADS) break;
    cursor = result.nextCursor;
  }
  return matches;
}

export function toAgentMessage(message: ConversationMessage, ownerAgentId?: string): AgentMessage {
  const exchangeSenderId = message.senderAgentId ?? message.exchange?.senderAgentId;
  const routineEvent = routineConversationEvent(message);
  const routineRunEvent = routineRunConversationEvent(message);
  const hostedSiteEvent = hostedSiteConversationEvent(message);
  const actionMarker = chatActionMarker(message, ownerAgentId, routineEvent, routineRunEvent, hostedSiteEvent);
  const plan = messagePlan(message);
  const subagents = message.itemType === CONVERSATION_SUBAGENTS_ITEM_TYPE ? message.subagents : undefined;
  const memoryChanges = message.author === "system" && message.itemType === CONVERSATION_MEMORY_CHANGES_ITEM_TYPE;
  const senderMember = message.author === "user" ? message.senderMember : undefined;
  const status =
    message.exchange || message.routine
      ? undefined
      : message.delivery?.status === "queued"
        ? `Queued #${message.delivery.position}`
        : message.delivery?.status === "cancelled"
          ? "Cancelled"
          : message.status === "failed"
            ? "Failed"
            : message.status === "interrupted"
              ? "Stopped"
              : undefined;
  return {
    id: message.id,
    ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
    author: message.author === "user" ? "you" : "agent",
    body: conversationMessageBody(message),
    time: formatMessageTime(message.createdAt),
    createdAt: message.createdAt,
    ...(message.author === "user" && message.delivery?.steered
      ? { receipt: { seenTime: message.delivery.readAt ? formatMessageTime(message.delivery.readAt) : null } }
      : {}),
    streaming: message.status === "streaming",
    ...(message.itemType === undefined ? {} : { itemType: message.itemType }),
    kind: message.questionPrompt
      ? "question"
      : actionMarker
        ? "action-marker"
        : plan
          ? "plan"
          : subagents?.length
            ? "subagents"
            : memoryChanges
              ? "memory-changes"
              : "text",
    ...(exchangeSenderId === undefined ? {} : { senderAgentId: exchangeSenderId }),
    ...(senderMember === undefined ? {} : { senderMember }),
    ...(message.replyToMessageId === undefined ? {} : { replyToMessageId: message.replyToMessageId }),
    ...(message.steered ? { steered: true as const } : {}),
    ...(message.attachments === undefined ? {} : { attachments: message.attachments }),
    ...(message.voiceRecording === undefined ? {} : { voiceRecording: message.voiceRecording }),
    ...(message.imageGeneration === undefined ? {} : { imageGeneration: message.imageGeneration }),
    ...(message.videoGeneration === undefined ? {} : { videoGeneration: message.videoGeneration }),
    ...(message.questionPrompt === undefined ? {} : { questionPrompt: message.questionPrompt }),
    ...(message.uiBlock ? { uiBlock: message.uiBlock } : {}),
    ...(message.exchange === undefined ? {} : { exchange: message.exchange }),
    ...(message.reaction === undefined ? {} : { reaction: message.reaction }),
    reactions:
      message.reactions ?? (message.reaction ? [{ emoji: message.reaction, actor: { kind: "user" as const } }] : []),
    ...(message.routine === undefined ? {} : { routine: message.routine }),
    ...(actionMarker ? { actionMarker } : {}),
    ...(plan ? { plan } : {}),
    ...(subagents?.length ? { subagents } : {}),
    ...(memoryChanges && message.memoryChanges ? { memoryChanges: message.memoryChanges } : {}),
    ...(message.trace === undefined ? {} : { trace: message.trace }),
    ...(status === undefined ? {} : { status }),
  };
}

function messagePlan(message: ConversationMessage): AgentMessagePlan | null {
  if (message.author !== "assistant" || message.itemType !== CONVERSATION_PLAN_ITEM_TYPE) return null;
  const plan = message.plan ?? parseConversationPlanText(message.text);
  if (!plan?.steps.length) return null;
  return { ...plan, stopped: message.status === "interrupted" || message.status === "failed" };
}

export function planItems(plan: AgentMessagePlan, streaming: boolean): TaskListItem[] {
  return plan.steps.map((step) => {
    const state =
      step.status === "completed" ? "done" : step.status === "inProgress" && streaming ? "active" : "pending";
    return { id: step.id, label: state === "active" ? (step.activeText ?? step.text) : step.text, state };
  });
}

const PLAN_TITLE_LIMIT = 80;

export function replacedPlanIds(messages: readonly AgentMessage[]): ReadonlySet<string> {
  return replacedConversationPlans(
    messages.map((message) => ({
      id: message.id,
      turnId: message.turnId,
      agent:
        message.author === "agent" && !message.exchange && !message.actionMarker && message.kind !== "memory-changes"
          ? (message.senderAgentId ?? "")
          : null,
      plan: message.kind === "plan",
    })),
  );
}

export function planTitle(plan: AgentMessagePlan, replaced: boolean): string {
  const { t } = currentText();
  if (plan.stopped && !replaced && plan.steps.some((step) => step.status !== "completed"))
    return t("chat.taskList.stopped");
  if (plan.explanation && plan.explanation.length <= PLAN_TITLE_LIMIT) return plan.explanation;
  return t("chat.taskList.title");
}

function cardShownAttachmentIds(messages: readonly ConversationMessage[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    const spec = message.uiBlock?.spec;
    if (!spec) continue;
    const sources = [
      ...(spec.media ?? []).map((item) => item.src),
      ...(spec.type === "form" ? spec.fields.map((field) => field.clip?.src) : []),
    ];
    for (const src of sources) {
      const id = src?.split("/").at(-1);
      if (id) ids.add(id);
    }
  }
  return ids;
}

/** Fork (docs/fork/FEATURES.md #132): the chat side of `deliveryWaitsForProvider`. */
function startingMessageWaits(message: ConversationMessage): boolean {
  if (message.delivery?.status !== "starting" || message.routine || message.source === "routine") return false;
  const exchange = message.exchange;
  return !(exchange?.direction === "incoming" && Boolean(exchange.replyToMessageId) && exchange.expectsReply === false);
}

function shownOnCard(message: ConversationMessage, onCards: ReadonlySet<string>): boolean {
  if (onCards.size === 0 || message.itemType !== "agent_attachment" || message.text.trim()) return false;
  const attachments = message.attachments ?? [];
  return attachments.length > 0 && attachments.every((attachment) => onCards.has(attachment.id));
}

export function toAgentMessages(
  messages: readonly ConversationMessage[],
  ownerAgentId?: string,
  convert: (message: ConversationMessage, index: number) => AgentMessage = (message) =>
    toAgentMessage(message, ownerAgentId),
  options: { holdStarting?: boolean } = {},
): AgentMessage[] {
  const result: AgentMessage[] = [];
  const thinkingByTurn = new Map<string, AgentMessage>();
  const onCards = cardShownAttachmentIds(messages);
  for (const [index, message] of messages.entries()) {
    // Fork ("Card media"): the files an ask_ui card shows itself are not shown again above it.
    if (shownOnCard(message, onCards)) continue;
    if ((message.delivery?.status === "queued" || message.delivery?.status === "cancelled") && !message.routine) {
      continue;
    }
    // Fork (docs/fork/FEATURES.md #132): a message the host is still starting waits in the queue panel
    // (or as the sender's own bubble) until the provider takes it, so it never shows here and then leaves.
    if (options.holdStarting && startingMessageWaits(message)) continue;
    if (message.itemType === AGENT_WELCOME_ITEM_TYPE || message.itemType === CHANNEL_RESUME_ITEM_TYPE) continue;
    if (message.author !== "assistant" || message.itemType !== "commentary") {
      result.push(convert(message, index));
      continue;
    }

    const key = message.turnId ?? message.id;
    const existing = thinkingByTurn.get(key);
    if (existing) {
      const text = cleanAgentMessageText(message.text);
      existing.items = [...(existing.items ?? []), text];
      existing.itemIds = [...(existing.itemIds ?? []), message.id];
      existing.itemCreatedAt = [...(existing.itemCreatedAt ?? []), message.createdAt];
      existing.itemStreaming = [...(existing.itemStreaming ?? []), message.status === "streaming"];
      existing.streaming = existing.streaming || message.status === "streaming";
      if (message.trace) existing.trace = message.trace;
      continue;
    }

    const text = cleanAgentMessageText(message.text);
    const thinking: AgentMessage = {
      id: `thinking:${key}`,
      ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
      author: "agent",
      body: "",
      time: formatMessageTime(message.createdAt),
      createdAt: message.createdAt,
      streaming: message.status === "streaming",
      itemType: "commentary",
      kind: "thinking",
      items: [text],
      itemIds: [message.id],
      itemCreatedAt: [message.createdAt],
      itemStreaming: [message.status === "streaming"],
      ...(message.trace === undefined ? {} : { trace: message.trace }),
    };
    thinkingByTurn.set(key, thinking);
    result.push(thinking);
  }
  return result;
}

export function agentProfilesEqual(left: AgentProfile, right: AgentProfile): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.title === right.title &&
    left.description === right.description &&
    left.notifications === right.notifications &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.providerAccountId === right.providerAccountId &&
    JSON.stringify(left.backupModels) === JSON.stringify(right.backupModels) &&
    (left.additionalFolders ?? []).join("\n") === (right.additionalFolders ?? []).join("\n") &&
    (left.excludedFolders ?? []).join("\n") === (right.excludedFolders ?? []).join("\n") &&
    JSON.stringify(left.usageLimitReturn) === JSON.stringify(right.usageLimitReturn) &&
    JSON.stringify(left.pendingRuntime) === JSON.stringify(right.pendingRuntime) &&
    left.access === right.access &&
    left.computerUse === right.computerUse &&
    left.allowAutomation === right.allowAutomation &&
    left.allowNewChat === right.allowNewChat &&
    left.quickAcknowledgement === right.quickAcknowledgement &&
    left.memory === right.memory &&
    left.fastMode === right.fastMode &&
    left.ultrafast === right.ultrafast &&
    left.ownBrowserSession === right.ownBrowserSession &&
    left.browserProfileId === right.browserProfileId &&
    left.busyMessageMode === right.busyMessageMode &&
    left.taskLimit === right.taskLimit &&
    left.threadId === right.threadId &&
    left.avatarSeed === right.avatarSeed &&
    left.avatarHue === right.avatarHue &&
    (left.avatarColor ?? null) === (right.avatarColor ?? null) &&
    left.chatColor === right.chatColor &&
    left.avatarUrl === right.avatarUrl &&
    marketplaceSourcesEqual(left.marketplaceSource, right.marketplaceSource) &&
    left.updatedAt === right.updatedAt &&
    left.time === right.time &&
    left.preview === right.preview
  );
}

function marketplaceSourcesEqual(
  left: AgentProfile["marketplaceSource"],
  right: AgentProfile["marketplaceSource"],
): boolean {
  if (!left || !right) return left === right;
  return (
    left.listingId === right.listingId &&
    left.versionId === right.versionId &&
    left.version === right.version &&
    stringArraysEqual(left.skillIds, right.skillIds) &&
    stringArraysEqual(left.routineIds, right.routineIds)
  );
}

function stringArraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function agentMessagesEqual(left: AgentMessage, right: AgentMessage): boolean {
  if (left === right) return true;
  return (
    left.id === right.id &&
    left.turnId === right.turnId &&
    left.author === right.author &&
    left.body === right.body &&
    left.time === right.time &&
    left.createdAt === right.createdAt &&
    left.kind === right.kind &&
    left.streaming === right.streaming &&
    left.itemType === right.itemType &&
    left.status === right.status &&
    left.receipt?.seenTime === right.receipt?.seenTime &&
    (left.receipt === undefined) === (right.receipt === undefined) &&
    left.senderAgentId === right.senderAgentId &&
    left.senderMember?.id === right.senderMember?.id &&
    left.senderMember?.name === right.senderMember?.name &&
    left.replyToMessageId === right.replyToMessageId &&
    left.steered === right.steered &&
    left.reaction === right.reaction &&
    sameJson(left.reactions, right.reactions) &&
    sameJson(left.reactionSummary, right.reactionSummary) &&
    sameJson(left.attachments, right.attachments) &&
    sameJson(left.questionPrompt, right.questionPrompt) &&
    sameJson(left.exchange, right.exchange) &&
    sameJson(left.routine, right.routine) &&
    sameJson(left.actionMarker, right.actionMarker) &&
    sameJson(left.items, right.items) &&
    sameJson(left.itemIds, right.itemIds) &&
    sameJson(left.itemStreaming, right.itemStreaming) &&
    sameJson(left.itemCreatedAt, right.itemCreatedAt) &&
    sameJson(left.plan, right.plan) &&
    sameJson(left.subagents, right.subagents) &&
    sameJson(left.voiceRecording, right.voiceRecording) &&
    sameJson(left.imageGeneration, right.imageGeneration) &&
    sameJson(left.videoGeneration, right.videoGeneration) &&
    sameJson(left.uiBlock, right.uiBlock) &&
    sameJson(left.memoryChanges, right.memoryChanges) &&
    sameJson(left.trace, right.trace)
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (hasOwnJson(left) || hasOwnJson(right)) return JSON.stringify(left) === JSON.stringify(right);
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.some(hasOwnJson) || right.some(hasOwnJson)) return JSON.stringify(left) === JSON.stringify(right);
    return left.length === right.length && left.every((item, index) => sameJsonArrayItem(item, right[index]));
  }
  if (isJsonObject(left) || isJsonObject(right)) {
    if (!isJsonObject(left) || !isJsonObject(right)) return false;
    const leftEntries = Object.entries(left).filter(([, value]) => !leftOutOfJson(value));
    const rightEntries = Object.entries(right).filter(([, value]) => !leftOutOfJson(value));
    const ownJson = ([, value]: [string, unknown]) => hasOwnJson(value);
    if (leftEntries.some(ownJson) || rightEntries.some(ownJson)) return JSON.stringify(left) === JSON.stringify(right);
    return (
      leftEntries.length === rightEntries.length &&
      leftEntries.every(([key, value], index) => {
        const other = rightEntries[index];
        return other !== undefined && other[0] === key && sameJson(value, other[1]);
      })
    );
  }
  return jsonScalar(left) === jsonScalar(right);
}

function hasOwnJson(value: unknown): boolean {
  if (typeof value === "bigint") return true;
  if (typeof value !== "object" || value === null) return false;
  if ("toJSON" in value) return true;
  const prototype = Object.getPrototypeOf(value);
  return prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null;
}

function isJsonObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function leftOutOfJson(value: unknown): boolean {
  return typeof value === "undefined" || typeof value === "function" || typeof value === "symbol";
}

function sameJsonArrayItem(left: unknown, right: unknown): boolean {
  return sameJson(leftOutOfJson(left) ? null : left, leftOutOfJson(right) ? null : right);
}

function jsonScalar(value: unknown): string | number | boolean | null | undefined {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return value === null ? null : undefined;
}

function chatActionMarker(
  message: ConversationMessage,
  ownerAgentId: string | undefined,
  routineEvent: ReturnType<typeof routineConversationEvent>,
  routineRunEvent: ReturnType<typeof routineRunConversationEvent>,
  hostedSiteEvent: ReturnType<typeof hostedSiteConversationEvent>,
): ChatActionMarkerModel | null {
  if (message.exchange) {
    const targetDeliveries = message.exchange.deliveries.map((delivery) => ({
      agentId: delivery.recipientAgentId,
      status: delivery.status,
    }));
    const status =
      message.exchange.direction === "incoming"
        ? deliveryStatus(message.delivery?.status ?? targetDeliveries[0]?.status)
        : aggregateDeliveryStatus(targetDeliveries.map((delivery) => delivery.status));
    return {
      kind: "agent-message",
      direction: message.exchange.direction,
      sourceAgentId: message.exchange.senderAgentId,
      targetDeliveries,
      status,
      timestamp: message.createdAt,
      messageId: message.exchange.messageId,
      replyToMessageId: message.exchange.replyToMessageId,
      expectsReply: message.exchange.expectsReply !== false,
      ...(message.exchange.senderTaskId === undefined ? {} : { senderTaskId: message.exchange.senderTaskId }),
    };
  }
  if (isContextResetMarker(message)) return { kind: "context-reset", timestamp: message.createdAt };
  const switchReason = modelSwitchReason(message);
  if (switchReason)
    return { kind: "model-switch", reason: switchReason, text: message.text, timestamp: message.createdAt };
  if (isChannelChangeMarker(message))
    return { kind: "channel-change", text: message.text, timestamp: message.createdAt };
  if (isVaultChangeMarker(message)) return { kind: "vault-change", text: message.text, timestamp: message.createdAt };
  if (isPlanContinuationMarker(message))
    return { kind: "plan-continuation", text: message.text, timestamp: message.createdAt };
  const signInProvider = signInFailureProvider(message);
  if (signInProvider)
    return { kind: "sign-in-failure", provider: signInProvider, text: message.text, timestamp: message.createdAt };
  if (message.author === "system" && message.itemType === AGENT_INSTRUCTIONS_CHANGE_ITEM_TYPE)
    return {
      kind: "instructions-change",
      agentId: ownerAgentId ?? null,
      change: message.instructionsChange ?? null,
      text: message.text,
      timestamp: message.createdAt,
    };
  const skillEvent = skillConversationEvent(message);
  if (skillEvent) return { ...skillEvent, kind: "skill-lifecycle", timestamp: message.createdAt };
  const suggestion = marketplaceSuggestionEvent(message);
  if (suggestion) return { kind: "marketplace-suggestion", appId: suggestion.appId, timestamp: message.createdAt };
  const settingLink = settingLinkEvent(message);
  if (settingLink) return { kind: "setting-link", settingId: settingLink.settingId, timestamp: message.createdAt };
  const skillSuggestion = skillSuggestionEvent(message);
  if (skillSuggestion) return { ...skillSuggestion, kind: "skill-suggestion", timestamp: message.createdAt };
  const signIn = mcpSignInEvent(message);
  if (signIn) return { kind: "mcp-sign-in", mcpServerId: signIn.mcpServerId, timestamp: message.createdAt };
  const install = serverInstallEvent(message);
  if (install) return { kind: "server-install", ...install, timestamp: message.createdAt };
  const issue = feedbackSentIssue(message);
  if (issue)
    return {
      kind: "feedback-sent",
      messageId: message.id,
      ...issue,
      title: feedbackSentTitle(message.text),
      timestamp: message.createdAt,
    };
  if (routineEvent) {
    return {
      kind: "routine-lifecycle",
      action: routineEvent.action,
      sourceAgentId: ownerAgentId ?? null,
      routineId: routineEvent.routineId,
      routineName: routineEvent.routineName,
      status: "completed",
      timestamp: message.createdAt,
    };
  }
  if (routineRunEvent) {
    return {
      kind: "routine-run",
      sourceAgentId: ownerAgentId ?? null,
      routineId: routineRunEvent.routineId,
      runId: routineRunEvent.runId,
      routineName: routineRunEvent.routineName,
      status: routineRunEvent.status,
      timestamp: message.createdAt,
    };
  }
  if (message.routine) {
    return {
      kind: "routine-run",
      sourceAgentId: ownerAgentId ?? null,
      routineId: message.routine.routineId,
      runId: message.routine.runId,
      routineName: message.routine.name,
      status: "queued",
      timestamp: message.createdAt,
    };
  }
  if (hostedSiteEvent) {
    return {
      kind: "hosted-site",
      sourceAgentId: ownerAgentId ?? null,
      action: hostedSiteEvent.action,
      status: hostedSiteEvent.status,
      operationId: hostedSiteEvent.operationId,
      siteId: hostedSiteEvent.siteId,
      title: hostedSiteEvent.title,
      hostname: hostedSiteEvent.hostname,
      url: hostedSiteEvent.url,
      timestamp: message.createdAt,
    };
  }
  if (isRoutineEventItem(message)) {
    return { kind: "unavailable", label: currentText().t("app.action.unavailable"), timestamp: message.createdAt };
  }
  return null;
}

function aggregateDeliveryStatus(statuses: QueueDeliveryStatus[]): AgentDeliveryMarkerStatus {
  if (statuses.length === 0) return "unavailable";
  const normalized = statuses.map(deliveryStatus);
  if (normalized.every((status) => status === "queued")) return "queued";
  if (normalized.some((status) => status === "in-progress")) return "in-progress";
  if (normalized.every((status) => status === "completed")) return "completed";
  if (normalized.every((status) => status === "failed")) return "failed";
  if (normalized.every((status) => status === "interrupted")) return "interrupted";
  if (normalized.every((status) => status === "cancelled")) return "cancelled";
  if (normalized.every((status) => ["completed", "failed", "interrupted", "cancelled"].includes(status))) {
    return "partial";
  }
  return "in-progress";
}

function deliveryStatus(status: QueueDeliveryStatus | undefined): Exclude<AgentDeliveryMarkerStatus, "partial"> {
  if (!status) return "unavailable";
  // Fork (docs/fork/FEATURES.md #132): a delivery the provider has not taken yet still waits, so a refused
  // start does not flip the sender's chip from "in progress" back to "queued".
  if (status === "starting") return "queued";
  if (status === "running") return "in-progress";
  return status;
}

export function retainThinkingMessages(
  previous: AgentMessage[],
  next: AgentMessage[],
  activeTurnId: string | null,
): AgentMessage[] {
  const result = [...next];
  const nextIds = new Set(result.map((message) => message.id));
  for (const thinking of previous) {
    if (thinking.kind !== "thinking" || nextIds.has(thinking.id) || !thinking.turnId) continue;
    if (thinking.turnId !== activeTurnId) continue;
    const sameTurnIndexes = result.flatMap((message, index) => (message.turnId === thinking.turnId ? [index] : []));
    if (sameTurnIndexes.length === 0) continue;
    const finalAnswerIndex = result.findIndex(
      (message) => message.turnId === thinking.turnId && message.author === "agent" && message.kind !== "thinking",
    );
    const insertionIndex = finalAnswerIndex >= 0 ? finalAnswerIndex : (sameTurnIndexes.at(-1) ?? result.length - 1) + 1;
    result.splice(insertionIndex, 0, {
      ...thinking,
      streaming: false,
      ...(thinking.itemStreaming ? { itemStreaming: thinking.itemStreaming.map(() => false) } : {}),
    });
    nextIds.add(thinking.id);
  }
  return result;
}

interface TurnCoverage {
  ids: ReadonlySet<string>;
  turns: ReadonlyMap<string, { first: string; last: string }>;
}

export function turnCoverage(messages: readonly ConversationMessage[]): TurnCoverage {
  const ids = new Set<string>();
  const turns = new Map<string, { first: string; last: string }>();
  for (const message of messages) {
    ids.add(message.id);
    if (!message.turnId || !message.createdAt) continue;
    const range = turns.get(message.turnId);
    if (!range) turns.set(message.turnId, { first: message.createdAt, last: message.createdAt });
    else {
      if (message.createdAt < range.first) range.first = message.createdAt;
      if (message.createdAt > range.last) range.last = message.createdAt;
    }
  }
  return { ids, turns };
}

export function withUnreachedTurnSteps(
  loaded: AgentMessage | undefined,
  incoming: AgentMessage,
  coverage: TurnCoverage,
): AgentMessage {
  if (loaded?.kind !== "thinking" || incoming.kind !== "thinking" || !incoming.turnId) return incoming;
  if (loaded.turnId !== incoming.turnId) return incoming;
  const range = coverage.turns.get(incoming.turnId);
  const incomingIds = new Set(incoming.itemIds ?? []);
  type Item = { text: string; id: string | undefined; createdAt: string | undefined; streaming: boolean };
  const kept: Item[] = [];
  for (const [index, text] of (loaded.items ?? []).entries()) {
    const id = loaded.itemIds?.[index];
    const createdAt = loaded.itemCreatedAt?.[index];
    if (!id || incomingIds.has(id) || coverage.ids.has(id)) continue;
    if (range && createdAt && createdAt >= range.first && createdAt <= range.last) continue;
    kept.push({ text, id, createdAt, streaming: false });
  }
  if (kept.length === 0) return incoming;
  const items: Item[] = [
    ...kept,
    ...(incoming.items ?? []).map((text, index) => ({
      text,
      id: incoming.itemIds?.[index],
      createdAt: incoming.itemCreatedAt?.[index],
      streaming: incoming.itemStreaming?.[index] === true,
    })),
  ];
  items.sort((left, right) => (left.createdAt ?? "").localeCompare(right.createdAt ?? ""));
  const createdAt = items.find((item) => item.createdAt)?.createdAt ?? incoming.createdAt;
  return {
    ...incoming,
    ...(createdAt ? { createdAt, time: formatMessageTime(createdAt) } : {}),
    items: items.map((item) => item.text),
    itemIds: items.map((item) => item.id ?? ""),
    itemCreatedAt: items.map((item) => item.createdAt ?? ""),
    itemStreaming: items.map((item) => item.streaming),
  };
}

export function placeTurnStepRows(messages: AgentMessage[]): AgentMessage[] {
  let result = messages;
  for (const thinking of messages) {
    if (thinking.kind !== "thinking" || !thinking.turnId || !thinking.createdAt) continue;
    const at = thinking.createdAt;
    const index = result.indexOf(thinking);
    const target = result.findIndex(
      (message) =>
        message.turnId === thinking.turnId &&
        message.kind !== "thinking" &&
        message.createdAt !== undefined &&
        message.createdAt > at,
    );
    if (target < 0 || target >= index) continue;
    if (result === messages) result = [...messages];
    result.splice(index, 1);
    result.splice(target, 0, thinking);
  }
  return result;
}

export function withoutAgent<T>(values: Record<string, T>, agentId: string): Record<string, T> {
  if (!Object.hasOwn(values, agentId)) return values;
  const next = { ...values };
  delete next[agentId];
  return next;
}

function cleanPreview(preview: string): string {
  const cleaned = markdownPreviewText(cleanAgentMessageText(preview))
    .replace(/\binbox\s+at\s+zero\b[:,]?\s*/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned || currentText().t("app.agent.noMessages");
}

function formatTime(value: string): string {
  const date = new Date(value);
  const { t, format } = currentText();
  if (Number.isNaN(date.getTime())) return t("chat.day.now");
  return format.date(date, { hour: "2-digit", minute: "2-digit" });
}

export function formatMessageTime(value: string): string {
  const date = new Date(value);
  const { t, format } = currentText();
  if (Number.isNaN(date.getTime())) return t("chat.day.now");
  return formatChatTimestamp(date, format);
}
