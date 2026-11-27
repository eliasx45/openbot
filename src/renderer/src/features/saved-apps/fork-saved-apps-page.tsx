// Fork (docs/fork/FEATURES.md #123): the Apps page: saved apps as cards with live thumbnails, or one app
// full-pane; and the bridge that opens apps and chats from links and from apps' own windows.

import type { SavedApp, SavedAppChatTarget } from "@openbot/contracts/fork-saved-apps";
import { AppWindow, Button, DropdownMenu, Ellipsis, Input, MessageSquare, Pencil, Trash2 } from "@openbot/ui";
import { PageHeader } from "@openbot/ui/features/window/PageHeader";
import { useText } from "@openbot/ui/text";
import { createSignal, For, onCleanup, onSettled, Show, untrack } from "solid-js";
import { useNavigation } from "../../navigation";
import { useAgents } from "../agents/agents-context";
import { useServerSelection } from "../servers/server-selection";
import { useServers } from "../servers/servers-context";
import { SavedAppInstalledPill, SavedAppInstallItems, useSavedAppInstall } from "./fork-saved-app-install";
import { SavedAppMark, SavedAppThumb, SavedAppView } from "./fork-saved-app-view";
import {
  installedSavedApp,
  openSavedAppPage,
  runSavedAppInstall,
  savedApps,
  savedAppsFailed,
  savedAppsLoaded,
  savedAppsPort,
  shownSavedAppId,
  showSavedApp,
  takeSavedApp,
  watchSavedApps,
} from "./fork-saved-apps-store";

const UNDO_MS = 6_000;

/** A chat to show after the server switch it needs; the scope that does it mounts again after the switch. */
let pendingChat: SavedAppChatTarget | null = null;

/** Opens the chat of an app at the message of its shown version, switching the server first when needed. */
export function useSavedAppChat() {
  const navigation = useNavigation();
  const { activeServerId } = useServers();
  const { selectServer } = useServerSelection();
  const show = (target: SavedAppChatTarget) => {
    if (target.messageId) navigation.selectGlobalSearchMessage(target.agentId, target.messageId);
    else navigation.selectAgent(target.agentId);
  };
  return {
    goToChat(target: SavedAppChatTarget) {
      if (target.serverId === untrack(activeServerId)) return show(target);
      pendingChat = target;
      void selectServer(target.serverId).catch(() => {
        pendingChat = null;
      });
    },
    takePending() {
      const target = pendingChat;
      if (!target || target.serverId !== untrack(activeServerId)) return;
      pendingChat = null;
      show(target);
    },
  };
}

/** Main window only: openbot://app/<id>, "Go to chat" of an app window, and the apps list kept current. */
export function SavedAppsBridge() {
  const chat = useSavedAppChat();
  onSettled(() => {
    const port = savedAppsPort();
    if (!port) return;
    watchSavedApps();
    chat.takePending();
    const stopOpen = port.onForkOpenSavedApp((id) => openSavedAppPage(id));
    const stopChat = port.onForkGoToSavedAppChat((target) => chat.goToChat(target));
    void port
      .forkTakePendingSavedApp()
      .then((id) => id && openSavedAppPage(id))
      .catch(() => undefined);
    return () => {
      stopOpen();
      stopChat();
    };
  });
  return null;
}

export function SavedAppsPage() {
  const { t } = useText();
  const { agentList } = useAgents();
  const { activeServerId } = useServers();
  const chat = useSavedAppChat();
  const [hidden, setHidden] = createSignal<ReadonlySet<string>>(new Set());
  const [removed, setRemoved] = createSignal<{ app: SavedApp; timer: ReturnType<typeof setTimeout> } | null>(null);
  const [failure, setFailure] = createSignal<string | null>(null);
  const install = useSavedAppInstall(setFailure);
  watchSavedApps();

  const agentName = (app: SavedApp) =>
    app.agentName ??
    (app.serverId === activeServerId() ? agentList().find((agent) => agent.id === app.agentId)?.name : undefined) ??
    t("app.savedApps.agentFallback");
  const shown = () => savedApps().filter((app) => !hidden().has(app.id));
  const open = () => {
    const id = shownSavedAppId();
    return id ? (savedApps().find((app) => app.id === id) ?? null) : null;
  };
  const goToChat = (app: SavedApp) =>
    chat.goToChat({ serverId: app.serverId, agentId: app.agentId, messageId: app.messageId });
  const ownWindow = (app: SavedApp) => void savedAppsPort()?.forkOpenSavedAppWindow(app.id);

  // The removal waiting for its undo time; a plain variable, as signal writes show only at the next flush.
  let waiting: { app: SavedApp; timer: ReturnType<typeof setTimeout> } | null = null;
  const commitRemove = () => {
    const pending = waiting;
    if (!pending) return;
    clearTimeout(pending.timer);
    waiting = null;
    setRemoved(null);
    void savedAppsPort()
      ?.forkRemoveSavedApp(pending.app.id)
      .catch(() => {
        setHidden((ids) => new Set([...ids].filter((id) => id !== pending.app.id)));
        setFailure(t("app.savedApps.actionFailed"));
      });
  };
  const remove = (app: SavedApp) => {
    if (waiting?.app.id === app.id) return;
    commitRemove();
    setFailure(null);
    setHidden((ids) => new Set([...ids, app.id]));
    if (shownSavedAppId() === app.id) showSavedApp(null);
    waiting = { app, timer: setTimeout(commitRemove, UNDO_MS) };
    setRemoved(waiting);
  };
  const undo = () => {
    const pending = waiting;
    if (!pending) return;
    clearTimeout(pending.timer);
    waiting = null;
    setRemoved(null);
    setHidden((ids) => new Set([...ids].filter((id) => id !== pending.app.id)));
  };
  // Leaving the page removes at once what waits for its undo time.
  onCleanup(commitRemove);

  const rename = (app: SavedApp, name: string) => {
    const port = savedAppsPort();
    const cleaned = name.replace(/\s+/gu, " ").trim().slice(0, 80);
    if (!port || !cleaned || cleaned === app.name) return;
    takeSavedApp({ ...app, name: cleaned });
    port
      .forkRenameSavedApp({ id: app.id, name: cleaned })
      .then((saved) => {
        takeSavedApp(saved ?? app);
        // An installed app's launcher takes the new name (and letter): the new one is written, then the old goes.
        if (saved && installedSavedApp(saved.id))
          runSavedAppInstall(saved, "install").then(
            (reply) => !reply.ok && setFailure(t("app.savedApps.installFailed")),
            () => setFailure(t("app.savedApps.installFailed")),
          );
      })
      .catch(() => {
        takeSavedApp(app);
        setFailure(t("app.savedApps.actionFailed"));
      });
  };

  return (
    <Show
      when={open()}
      fallback={
        <div class="saved-apps-page">
          <PageHeader title={t("app.savedApps.title")} />
          <div class="saved-apps-body">
            <Show when={removed()}>
              {(pending) => (
                <p class="saved-apps-notice" role="status">
                  <span>{t("app.savedApps.removed", { name: pending().app.name })}</span>
                  <Button type="button" variant="link" size="xs" class="saved-apps-undo" onClick={undo}>
                    {t("app.savedApps.undo")}
                  </Button>
                </p>
              )}
            </Show>
            <Show when={failure()}>
              {(text) => (
                <p class="saved-apps-notice saved-apps-error" role="alert">
                  {text()}
                </p>
              )}
            </Show>
            <Show
              when={shown().length > 0}
              fallback={
                <Show when={savedAppsLoaded()}>
                  <div class="saved-apps-empty">
                    <span class="saved-apps-empty-tile" aria-hidden="true">
                      <AppWindow />
                    </span>
                    <h3>{savedAppsFailed() ? t("app.savedApps.loadFailed") : t("app.savedApps.emptyTitle")}</h3>
                    <p>{t("app.savedApps.emptyBody")}</p>
                  </div>
                </Show>
              }
            >
              <ul class="saved-apps-grid">
                <For each={shown()} keyed={(app) => app.id}>
                  {(app) => (
                    <SavedAppCard
                      app={app()}
                      agentName={agentName(app())}
                      onOpen={() => showSavedApp(app().id)}
                      onOwnWindow={() => ownWindow(app())}
                      onGoToChat={() => goToChat(app())}
                      onRename={(name) => rename(app(), name)}
                      onRemove={() => remove(app())}
                      install={install}
                    />
                  )}
                </For>
              </ul>
            </Show>
          </div>
        </div>
      }
    >
      {(app) => (
        <div class="saved-apps-page saved-apps-page-app">
          <SavedAppView
            app={app()}
            agentName={agentName(app())}
            onBack={() => showSavedApp(null)}
            onGoToChat={() => goToChat(app())}
            onOwnWindow={() => ownWindow(app())}
          />
        </div>
      )}
    </Show>
  );
}

function relativeTime(at: number, locale: string): string {
  const seconds = Math.round((at - Date.now()) / 1_000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of steps)
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  return format.format(0, "minute");
}

function SavedAppCard(props: {
  app: SavedApp;
  agentName: string;
  onOpen: () => void;
  onOwnWindow: () => void;
  onGoToChat: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
  install: ReturnType<typeof useSavedAppInstall>;
}) {
  const { t, format } = useText();
  const [renaming, setRenaming] = createSignal(false);
  let input: HTMLInputElement | undefined;
  let kept = false;
  const startRename = () => {
    kept = false;
    setRenaming(true);
    requestAnimationFrame(() => {
      input?.focus();
      input?.select();
    });
  };
  const finish = (keep: boolean) => {
    if (!renaming() || kept) return;
    kept = true;
    const value = input?.value ?? "";
    setRenaming(false);
    if (keep) props.onRename(value);
  };
  return (
    <li class="saved-app-card">
      <div class="saved-app-card-preview">
        <SavedAppThumb app={props.app} />
        <Button
          type="button"
          variant="ghost"
          class="saved-app-card-open"
          aria-label={t("app.savedApps.open", { name: props.app.name })}
          onClick={() => props.onOpen()}
        />
        <Button
          type="button"
          variant="secondary"
          size="icon-sm"
          class="saved-app-card-window"
          aria-label={t("app.savedApps.openOwnWindow", { name: props.app.name })}
          title={t("app.savedApps.ownWindow")}
          onClick={() => props.onOwnWindow()}
        >
          <AppWindow aria-hidden="true" />
        </Button>
      </div>
      <div class="saved-app-card-info">
        <SavedAppMark name={props.app.name} />
        <div class="saved-app-card-text">
          <Show
            when={renaming()}
            fallback={
              <Button
                type="button"
                variant="ghost"
                size="xs"
                class="saved-app-card-name"
                title={props.app.name}
                onClick={() => props.onOpen()}
              >
                {props.app.name}
              </Button>
            }
          >
            <Input
              ref={(element: HTMLInputElement) => {
                input = element;
                element.value = props.app.name;
              }}
              size="sm"
              class="saved-app-card-rename"
              aria-label={t("app.savedApps.renameLabel")}
              maxlength={80}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  finish(true);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  finish(false);
                }
              }}
              onBlur={() => finish(true)}
            />
          </Show>
          <p class="saved-app-card-meta">
            <span class="saved-app-card-meta-text">
              {props.agentName} · {relativeTime(props.app.updatedAt, format.locale)}
            </span>
            <SavedAppInstalledPill id={props.app.id} />
          </p>
        </div>
        <DropdownMenu.Root placement="bottom-end" gutter={6}>
          <DropdownMenu.Trigger
            class="ui-button ui-button-variant-ghost ui-button-size-icon-sm saved-app-card-more"
            aria-label={t("app.savedApps.more", { name: props.app.name })}
          >
            <Ellipsis aria-hidden="true" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content class="saved-app-card-menu">
              <DropdownMenu.Item onSelectAfterClose={startRename}>
                <Pencil aria-hidden="true" />
                <span>{t("app.savedApps.rename")}</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelectAfterClose={() => props.onGoToChat()}>
                <MessageSquare aria-hidden="true" />
                <span>{t("app.savedApps.goToChat")}</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelectAfterClose={() => props.onOwnWindow()}>
                <AppWindow aria-hidden="true" />
                <span>{t("app.savedApps.ownWindow")}</span>
              </DropdownMenu.Item>
              <SavedAppInstallItems app={props.app} run={props.install} separator />
              <DropdownMenu.Separator />
              <DropdownMenu.Item class="saved-app-card-remove" onSelectAfterClose={() => props.onRemove()}>
                <Trash2 aria-hidden="true" />
                <span>{t("app.savedApps.remove")}</span>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </li>
  );
}
