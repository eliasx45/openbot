import { leadingAddress } from "@openbot/contracts/chat-tag-references";
import type { ChannelCommand } from "@openbot/contracts/ipc";
import { createSignal } from "solid-js";
import { readPanelWidth, savePanelWidth } from "../../components/panel-width-storage";

export type ChannelSendCommand = Extract<ChannelCommand, { type: "send" }>;

export function channelSendCommand(input: {
  channelId: string;
  text: string;
  operationId: string;
  replyToMessageId: string | null;
  attachmentDraftIds: string[];
}): ChannelSendCommand {
  const mention = leadingAddress(input.text).mentions[0];
  return {
    type: "send",
    operationId: input.operationId,
    channelId: input.channelId,
    text: input.text,
    recipientAgentId: mention?.id ?? null,
    replyToMessageId: input.replyToMessageId,
    attachmentDraftIds: input.attachmentDraftIds,
  };
}

export function feedReplyTarget(feedShown: boolean, replyToMessageId: string | null): string | null {
  return feedShown ? null : replyToMessageId;
}

const JUST_NOW_MS = 45_000;
const relativeFormats = new Map<string, Intl.RelativeTimeFormat>();

export function feedRelativeTime(at: string, now: number, locale: string, justNow: string): string {
  const elapsed = now - Date.parse(at);
  if (!Number.isFinite(elapsed) || elapsed < JUST_NOW_MS) return justNow;
  let format = relativeFormats.get(locale);
  if (!format) {
    format = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
    relativeFormats.set(locale, format);
  }
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 60) return format.format(-Math.max(1, minutes), "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return format.format(-hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 7) return format.format(-days, "day");
  return format.format(-Math.round(days / 7), "week");
}

const VIEW_KEY_PREFIX = "openbot:channel-view:";
const CHAT_VIEW = "chat";

function readChatChannels(): ReadonlySet<string> {
  const ids = new Set<string>();
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(VIEW_KEY_PREFIX) && window.localStorage.getItem(key) === CHAT_VIEW)
        ids.add(key.slice(VIEW_KEY_PREFIX.length));
    }
  } catch {
    return ids;
  }
  return ids;
}

const [chatChannels, setChatChannels] = createSignal<ReadonlySet<string>>(
  typeof window === "undefined" ? new Set() : readChatChannels(),
);

function readStorageIntoSignal(event: StorageEvent): void {
  if (event.key !== null && !event.key.startsWith(VIEW_KEY_PREFIX)) return;
  setChatChannels(readChatChannels());
}

const WIDE_QUERY = "(min-width: 768px)";
const [wideWindow, setWideWindow] = createSignal(
  typeof window === "undefined" || typeof window.matchMedia !== "function" || window.matchMedia(WIDE_QUERY).matches,
);

if (typeof window !== "undefined") {
  window.addEventListener("storage", readStorageIntoSignal);
  const wide = typeof window.matchMedia === "function" ? window.matchMedia(WIDE_QUERY) : null;
  const readWide = (event: MediaQueryListEvent) => setWideWindow(event.matches);
  wide?.addEventListener("change", readWide);
  import.meta.hot?.dispose(() => {
    window.removeEventListener("storage", readStorageIntoSignal);
    wide?.removeEventListener("change", readWide);
  });
}

export function channelFeedChosen(channelId: string): boolean {
  return !chatChannels().has(channelId);
}

export function setChannelFeedChosen(channelId: string, feed: boolean): void {
  try {
    if (feed) window.localStorage.removeItem(`${VIEW_KEY_PREFIX}${channelId}`);
    else window.localStorage.setItem(`${VIEW_KEY_PREFIX}${channelId}`, CHAT_VIEW);
  } catch {}
  setChatChannels((current) => {
    const next = new Set(current);
    if (feed) next.delete(channelId);
    else next.add(channelId);
    return next;
  });
}

export function feedWindowWide(): boolean {
  return wideWindow();
}

export const OVERLAY_SELECTOR = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

export const THREAD_PANEL_DEFAULT = 440;
export const THREAD_PANEL_MIN = 360;
export const FEED_MIN = 360;
const THREAD_PANEL_KEY = "openbot:channel-thread-panel-width";

export function readThreadPanelWidth(): number {
  try {
    return readPanelWidth(THREAD_PANEL_KEY, THREAD_PANEL_DEFAULT, THREAD_PANEL_MIN, Number.POSITIVE_INFINITY);
  } catch {
    return THREAD_PANEL_DEFAULT;
  }
}

export function saveThreadPanelWidth(value: number): void {
  try {
    savePanelWidth(THREAD_PANEL_KEY, value);
  } catch {}
}

export function resetThreadPanelWidth(): void {
  try {
    window.localStorage.removeItem(THREAD_PANEL_KEY);
  } catch {}
}

export function threadPanelMaxWidth(available: number): number {
  return Math.max(THREAD_PANEL_MIN, available - FEED_MIN);
}
