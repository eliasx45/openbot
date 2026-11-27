// Fork (docs/fork/FEATURES.md #123): the renderer of a saved app's own window (?window=app&app=<id>):
// only the app, no rail. "Go to chat" shows the chat in the main window.

import { isSavedAppId, type SavedApp } from "@openbot/contracts/fork-saved-apps";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, Show } from "solid-js";
import { I18nProvider } from "../../i18n-context";
import { SavedAppView } from "./fork-saved-app-view";
import { savedApps, savedAppsLoaded, savedAppsPort, watchSavedApps } from "./fork-saved-apps-store";

export function readSavedAppWindowId(search: string): string | null {
  const query = new URLSearchParams(search);
  const id = query.get("app");
  return query.get("window") === "app" && isSavedAppId(id) ? id : null;
}

export function SavedAppWindow(props: { id: string }) {
  return (
    <I18nProvider>
      <SavedAppWindowBody id={props.id} />
    </I18nProvider>
  );
}

function SavedAppWindowBody(props: { id: string }) {
  const { t } = useText();
  watchSavedApps();
  const app = createMemo((): SavedApp | null => savedApps().find((one) => one.id === props.id) ?? null);
  createEffect(
    () => app()?.name,
    (name) => {
      if (name) document.title = `${name} · OpenBot`;
    },
  );
  return (
    <main class="saved-app-window" data-mac={/Mac/u.test(navigator.userAgent) ? "" : undefined}>
      <Show
        when={app()}
        fallback={
          <Show when={savedAppsLoaded()}>
            <p class="saved-app-window-missing">{t("app.savedApps.notFound")}</p>
          </Show>
        }
      >
        {(shown) => (
          <SavedAppView
            app={shown()}
            agentName={shown().agentName ?? t("app.savedApps.agentFallback")}
            inWindow
            onGoToChat={() => void savedAppsPort()?.forkShowSavedAppChat(props.id)}
          />
        )}
      </Show>
    </main>
  );
}
