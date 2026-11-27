// Fork (docs/fork/FEATURES.md #123): "Install on this computer" and "Add to Desktop" of a saved app, as menu items
// of its card and of its view, and the quiet "Installed" pill.

import type { SavedApp, SavedAppInstallReply } from "@openbot/contracts/fork-saved-apps";
import { Download, DropdownMenu, Monitor, X } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { Show } from "solid-js";
import {
  installedSavedApp,
  runSavedAppInstall,
  type SavedAppInstallAction,
  savedAppInstalls,
} from "./fork-saved-apps-store";

type Text = ReturnType<typeof useText>["t"];

/** The one line a failed action shows; null when it worked. */
function savedAppInstallFailure(t: Text, action: SavedAppInstallAction, reply: SavedAppInstallReply) {
  if (reply.ok) return null;
  switch (reply.reason) {
    case "no-desktop":
      return t("app.savedApps.installNoDesktop");
    case "taken":
      return t("app.savedApps.installTaken");
    case "unavailable":
      return reply.state.unavailable === "linux" ? t("app.savedApps.installLinux") : t("app.savedApps.installDev");
    default:
      return action === "uninstall" || action === "remove-from-desktop"
        ? t("app.savedApps.uninstallFailed")
        : t("app.savedApps.installFailed");
  }
}

const busy = new Set<string>();

/** Runs an action once at a time per app; `onFailure` gets the line to show, or null. */
export function useSavedAppInstall(onFailure: (line: string | null) => void) {
  const { t } = useText();
  return (app: SavedApp, action: SavedAppInstallAction) => {
    if (busy.has(app.id)) return;
    busy.add(app.id);
    onFailure(null);
    runSavedAppInstall(app, action)
      .then(
        (reply) => onFailure(savedAppInstallFailure(t, action, reply)),
        () =>
          onFailure(
            action === "uninstall" || action === "remove-from-desktop"
              ? t("app.savedApps.uninstallFailed")
              : t("app.savedApps.installFailed"),
          ),
      )
      .finally(() => busy.delete(app.id));
  };
}

/** The install items of a More menu; one disabled line where this computer cannot install apps. */
export function SavedAppInstallItems(props: {
  app: SavedApp;
  run: (app: SavedApp, action: SavedAppInstallAction) => void;
  /** A line above the items, where they follow others. */
  separator?: boolean;
}) {
  const { t } = useText();
  const installed = () => installedSavedApp(props.app.id);
  const unavailable = () => savedAppInstalls()?.unavailable ?? null;
  return (
    <Show when={savedAppInstalls()}>
      <Show when={props.separator}>
        <DropdownMenu.Separator />
      </Show>
      <Show
        when={unavailable() === null}
        fallback={
          <DropdownMenu.Item disabled class="saved-app-install-unavailable">
            <Download aria-hidden="true" />
            <span>{unavailable() === "linux" ? t("app.savedApps.installLinux") : t("app.savedApps.installDev")}</span>
          </DropdownMenu.Item>
        }
      >
        <Show
          when={installed()}
          fallback={
            <DropdownMenu.Item onSelectAfterClose={() => props.run(props.app, "install")}>
              <Download aria-hidden="true" />
              <span>{t("app.savedApps.install")}</span>
            </DropdownMenu.Item>
          }
        >
          <DropdownMenu.Item onSelectAfterClose={() => props.run(props.app, "uninstall")}>
            <X aria-hidden="true" />
            <span>{t("app.savedApps.uninstall")}</span>
          </DropdownMenu.Item>
        </Show>
        <Show
          when={installed()?.desktop}
          fallback={
            <DropdownMenu.Item onSelectAfterClose={() => props.run(props.app, "add-to-desktop")}>
              <Monitor aria-hidden="true" />
              <span>{t("app.savedApps.addToDesktop")}</span>
            </DropdownMenu.Item>
          }
        >
          <DropdownMenu.Item onSelectAfterClose={() => props.run(props.app, "remove-from-desktop")}>
            <Monitor aria-hidden="true" />
            <span>{t("app.savedApps.removeFromDesktop")}</span>
          </DropdownMenu.Item>
        </Show>
      </Show>
    </Show>
  );
}

export function SavedAppInstalledPill(props: { id: string }) {
  const { t } = useText();
  return (
    <Show when={installedSavedApp(props.id)}>
      <span class="saved-app-installed" title={t("app.savedApps.installedHint")}>
        {t("app.savedApps.installed")}
      </span>
    </Show>
  );
}
