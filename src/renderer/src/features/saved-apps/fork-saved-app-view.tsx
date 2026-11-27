// Fork (docs/fork/FEATURES.md #123): a saved app shown full-pane (Apps page) or in its own window, and the
// live thumbnail of its card. Shared by the main window and the app window.

import {
  CHAT_VISUAL_FRAME_SANDBOX,
  CHAT_VISUAL_STATE_UNAVAILABLE,
  type ChatVisualTheme,
  chatVisualFrameUrl,
  chatVisualStateReplyMessage,
  parseChatVisualMessage,
} from "@openbot/contracts/chat-visual";
import { type SavedApp, savedAppUrl } from "@openbot/contracts/fork-saved-apps";
import { AppWindow, ArrowLeft, Button, Check, ChevronDown, DropdownMenu, IconButton, MessageSquare } from "@openbot/ui";
import { documentColorScheme } from "@openbot/ui/document-color-scheme";
import { ChatVisual, visualTheme } from "@openbot/ui/features/conversation/ChatVisual";
import { useText } from "@openbot/ui/text";
import { createMemo, createSignal, For, onSettled, Show, untrack } from "solid-js";
import { pageStateHost, savedAppsPort, takeSavedApp } from "./fork-saved-apps-store";

/** The first letter of the name, for the tile shown before (or instead of) the live page. */
export function savedAppLetter(name: string): string {
  return (Array.from(name.trim())[0] ?? "A").toUpperCase();
}

export function SavedAppMark(props: { name: string }) {
  return (
    <span class="saved-app-mark" aria-hidden="true">
      {savedAppLetter(props.name)}
    </span>
  );
}

function openLink(url: string) {
  void window.openbot.openUrl(url);
}

export interface SavedAppViewProps {
  app: SavedApp;
  agentName: string;
  onBack?: (() => void) | undefined;
  onGoToChat: () => void;
  onOwnWindow?: (() => void) | undefined;
  /** The own window: room for the window buttons, and the header drags the window. */
  inWindow?: boolean | undefined;
}

export function SavedAppView(props: SavedAppViewProps) {
  const { t } = useText();
  const src = () => savedAppUrl(props.app.id, props.app.rev);
  const appId = () => props.app.id;
  return (
    <section class="saved-app-view" data-in-window={props.inWindow ? "" : undefined} aria-label={props.app.name}>
      <header class="saved-app-view-header">
        <div class="saved-app-view-identity">
          <Show when={props.onBack}>
            {(back) => (
              <IconButton variant="ghost" label={t("app.savedApps.back")} onClick={() => back()()}>
                <ArrowLeft />
              </IconButton>
            )}
          </Show>
          <SavedAppMark name={props.app.name} />
          <div class="saved-app-view-titles">
            <h2 class="saved-app-view-name">{props.app.name}</h2>
            <p class="saved-app-view-by">{t("app.savedApps.byAgent", { agent: props.agentName })}</p>
          </div>
        </div>
        <div class="saved-app-view-actions">
          <SavedAppVersionMenu app={props.app} />
          <Button variant="ghost" size="sm" type="button" onClick={() => props.onGoToChat()}>
            <MessageSquare aria-hidden="true" />
            <span>{t("app.savedApps.goToChat")}</span>
          </Button>
          <Show when={props.onOwnWindow}>
            {(open) => (
              <Button variant="ghost" size="sm" type="button" onClick={() => open()()}>
                <AppWindow aria-hidden="true" />
                <span>{t("app.savedApps.ownWindow")}</span>
              </Button>
            )}
          </Show>
        </div>
      </header>
      <div class="saved-app-view-body">
        <ChatVisual
          src={src()}
          title={props.app.name}
          fill
          onOpenLink={openLink}
          onState={pageStateHost(() => ({ appId: appId() }))}
        />
      </div>
    </section>
  );
}

function SavedAppVersionMenu(props: { app: SavedApp }) {
  const { t } = useText();
  let busy = false;
  const newestFirst = createMemo(() => [...props.app.versions].sort((a, b) => b.rev - a.rev));
  const label = () =>
    props.app.pinnedRev === undefined
      ? t("app.savedApps.newest")
      : t("app.savedApps.versionKept", { rev: props.app.pinnedRev });
  const pin = (rev: number | null) => {
    const port = savedAppsPort();
    if (!port || busy) return;
    const was = props.app;
    // Instant feedback: show the choice now, main's answer replaces it.
    const { pinnedRev: _old, ...rest } = was;
    takeSavedApp(
      rev === null ? { ...rest, rev: was.versions.at(-1)?.rev ?? was.rev } : { ...rest, pinnedRev: rev, rev },
    );
    busy = true;
    port
      .forkPinSavedApp({ id: was.id, rev })
      .then((saved) => takeSavedApp(saved ?? was))
      .catch(() => takeSavedApp(was))
      .finally(() => {
        busy = false;
      });
  };
  return (
    <DropdownMenu.Root placement="bottom-end" gutter={6}>
      <DropdownMenu.Trigger class="ui-button ui-button-variant-ghost ui-button-size-sm saved-app-version-trigger">
        <span>{label()}</span>
        <ChevronDown aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="saved-app-version-menu" aria-label={t("app.savedApps.versionMenu")}>
          <DropdownMenu.Item class="saved-app-version-item" onSelect={() => pin(null)}>
            <span class="saved-app-version-check">
              <Show when={props.app.pinnedRev === undefined}>
                <Check aria-hidden="true" />
              </Show>
            </span>
            <span class="saved-app-version-text">
              <span>{t("app.savedApps.newest")}</span>
              <small>{t("app.savedApps.newestHint")}</small>
            </span>
          </DropdownMenu.Item>
          <DropdownMenu.Separator class="saved-app-version-separator" />
          <For each={newestFirst()} keyed={(version) => version.rev}>
            {(version) => (
              <DropdownMenu.Item class="saved-app-version-item" onSelect={() => pin(version().rev)}>
                <span class="saved-app-version-check">
                  <Show when={props.app.pinnedRev === version().rev}>
                    <Check aria-hidden="true" />
                  </Show>
                </span>
                <span class="saved-app-version-text">
                  <span>{t("app.savedApps.version", { rev: version().rev })}</span>
                  <small>{new Date(version().at).toLocaleString()}</small>
                </span>
              </DropdownMenu.Item>
            )}
          </For>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

const THUMB_WIDTH = 880;

/** A live, inert picture of the app: its page at 880×550, scaled to the card, loaded when the card nears the view. */
export function SavedAppThumb(props: { app: SavedApp }) {
  let box: HTMLDivElement | undefined;
  let frame: HTMLIFrameElement | undefined;
  const [near, setNear] = createSignal(false);
  const [scale, setScale] = createSignal(0);
  const [theme, setTheme] = createSignal<ChatVisualTheme>();
  const url = () => {
    const current = theme();
    return near() && current ? chatVisualFrameUrl(savedAppUrl(props.app.id, props.app.rev), current) : undefined;
  };
  // The thumbnail reads the app's saved data (so it shows what the app shows) but cannot change it.
  const onMessage = (event: MessageEvent) => {
    const page = frame?.contentWindow;
    if (!page || event.source !== page) return;
    const message = parseChatVisualMessage(event.data);
    if (message?.type !== "state") return;
    const answer = (reply: Parameters<typeof chatVisualStateReplyMessage>[1]) => {
      if (frame?.contentWindow === page) page.postMessage(chatVisualStateReplyMessage(message.id, reply), "*");
    };
    const port = savedAppsPort();
    if (!port || message.request.op === "set") return answer({ ok: false, error: CHAT_VISUAL_STATE_UNAVAILABLE });
    port
      .forkPageState({ ...message.request, target: { appId: untrack(() => props.app.id) } })
      .then(answer, () => answer({ ok: false, error: CHAT_VISUAL_STATE_UNAVAILABLE }));
  };
  onSettled(() => {
    const element = box;
    if (!element) return;
    setTheme(visualTheme(element, untrack(documentColorScheme)));
    const seen = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setNear(true);
        seen.disconnect();
      },
      { rootMargin: "300px" },
    );
    seen.observe(element);
    const sized = new ResizeObserver(() => setScale(element.clientWidth / THUMB_WIDTH));
    sized.observe(element);
    window.addEventListener("message", onMessage);
    return () => {
      seen.disconnect();
      sized.disconnect();
      window.removeEventListener("message", onMessage);
    };
  });
  return (
    <div class="saved-app-thumb" ref={(element) => (box = element)} aria-hidden="true">
      <Show when={url()} fallback={<span class="saved-app-thumb-letter">{savedAppLetter(props.app.name)}</span>}>
        {(src) => (
          <iframe
            ref={(element) => (frame = element)}
            class="saved-app-thumb-frame"
            title={props.app.name}
            src={src()}
            sandbox={CHAT_VISUAL_FRAME_SANDBOX}
            referrerpolicy="no-referrer"
            tabindex={-1}
            inert
            style={{ transform: `scale(${scale()})` }}
          />
        )}
      </Show>
    </div>
  );
}
