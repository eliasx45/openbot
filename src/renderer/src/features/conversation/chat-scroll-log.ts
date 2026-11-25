/**
 * Fork (docs/fork/FEATURES.md #109). A note of why the chat left the latest message, or moved by more
 * than a screen with no input from the reader. The main process writes tagged lines into its log
 * (`src/main/fork-chat-scroll-log.ts`). Ids, counts and offsets only, never message text.
 */
const TAG = "[openbot:chat-scroll]";

export interface ChatScrollState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function chatScrollState(element: HTMLElement | undefined): ChatScrollState | undefined {
  if (!element) return undefined;
  return {
    scrollTop: Math.round(element.scrollTop),
    scrollHeight: Math.round(element.scrollHeight),
    clientHeight: Math.round(element.clientHeight),
  };
}

export interface ChatScrollNote extends Partial<ChatScrollState> {
  agentId: string | null;
  stickToLatest: boolean;
  rows: number;
  firstRow: string | undefined;
  lastRow: string | undefined;
  virtualized: boolean;
  messageId?: string;
  boundaryId?: string | null;
  boundaryIndex?: number;
  caller?: string | undefined;
  lastScrollTop?: number;
  moved?: number;
  readerLeftLatest?: boolean;
  dragging?: boolean;
}

export function noteChatScroll(reason: string, detail: ChatScrollNote): void {
  try {
    // biome-ignore lint/suspicious/noConsole: the main process writes these tagged lines into its log.
    console.info(`${TAG} ${JSON.stringify({ reason, at: new Date().toISOString(), ...detail })}`);
  } catch {}
}
