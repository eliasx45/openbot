// Fork (docs/fork/FEATURES.md #123): the saved apps the renderer shows, kept in step with main.

import type {
  PageStateOperation,
  PageStateReply,
  PageStateTarget,
  SaveAppPageInput,
  SavedApp,
} from "@openbot/contracts/fork-saved-apps";
import type { OpenBotDesktopApi } from "@openbot/contracts/ipc";
import { createSignal } from "solid-js";

export type SavedAppsPort = Pick<
  OpenBotDesktopApi,
  | "forkListSavedApps"
  | "forkGetSavedApp"
  | "forkSaveAppPage"
  | "forkRenameSavedApp"
  | "forkPinSavedApp"
  | "forkRemoveSavedApp"
  | "forkPageState"
  | "forkOpenSavedAppWindow"
  | "forkShowSavedAppChat"
  | "forkTakePendingSavedApp"
  | "onForkSavedAppsChanged"
  | "onForkOpenSavedApp"
  | "onForkGoToSavedAppChat"
>;

/** The desktop bridge, or null where there is none (the web client, the preview). */
export function savedAppsPort(): SavedAppsPort | null {
  const api: Partial<SavedAppsPort> | undefined = "openbot" in window ? window.openbot : undefined;
  return api && typeof api.forkSaveAppPage === "function" ? window.openbot : null;
}

const [apps, setApps] = createSignal<readonly SavedApp[]>([]);
const [loaded, setLoaded] = createSignal(false);
const [failed, setFailed] = createSignal(false);
/** The app shown on the Apps page; null shows the list. */
const [shownAppId, setShownAppId] = createSignal<string | null>(null);
/** Counts asks to show the Apps page, which the window page context follows. */
const [appsPageRequest, setAppsPageRequest] = createSignal(0);

export const savedApps = apps;
export const savedAppsLoaded = loaded;
export const savedAppsFailed = failed;
export const shownSavedAppId = shownAppId;
export const savedAppsPageRequest = appsPageRequest;

let watching = false;

/** Loads the apps once and follows main's changes. Safe to call again. */
export function watchSavedApps(): void {
  const port = savedAppsPort();
  if (!port || watching) return;
  watching = true;
  port.onForkSavedAppsChanged((next) => {
    setApps(next);
    setLoaded(true);
    setFailed(false);
  });
  void refreshSavedApps();
}

export async function refreshSavedApps(): Promise<void> {
  const port = savedAppsPort();
  if (!port) return;
  try {
    setApps(await port.forkListSavedApps());
    setFailed(false);
  } catch {
    setFailed(true);
  } finally {
    setLoaded(true);
  }
}

/** Replace one app at once with main's answer (rename, pin), before the change event arrives. */
export function takeSavedApp(app: SavedApp | null): void {
  if (!app) return;
  setApps((list) =>
    list.some((one) => one.id === app.id) ? list.map((one) => (one.id === app.id ? app : one)) : [app, ...list],
  );
}

export function showSavedApp(id: string | null): void {
  setShownAppId(id);
}

/** Show an app on the Apps page of this window. */
export function openSavedAppPage(id: string | null): void {
  setShownAppId(id);
  setAppsPageRequest((count) => count + 1);
}

export async function saveChatPageAsApp(input: SaveAppPageInput): Promise<string> {
  const port = savedAppsPort();
  if (!port) throw new Error("Saved apps are not available here.");
  const saved = await port.forkSaveAppPage(input);
  takeSavedApp(saved.app);
  return saved.app.id;
}

/** openbotPage.state for one frame. */
export function pageStateHost(
  target: () => PageStateTarget | null,
): ((request: PageStateOperation) => Promise<PageStateReply>) | undefined {
  const port = savedAppsPort();
  if (!port) return undefined;
  return async (request) => {
    const shown = target();
    if (!shown) return { ok: false, error: "Saved data is not available here." };
    return port.forkPageState({ ...request, target: shown });
  };
}
