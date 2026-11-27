// Fork (docs/fork/FEATURES.md #123): the saved apps the renderer shows, kept in step with main.

import type {
  PageDataOperation,
  PageStateOperation,
  PageStateReply,
  PageStateTarget,
  SaveAppPageInput,
  SavedApp,
  SavedAppInstallReply,
  SavedAppInstallState,
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
  | "forkSavedAppInstalls"
  | "forkInstallSavedApp"
  | "forkUninstallSavedApp"
  | "forkAddSavedAppToDesktop"
  | "forkRemoveSavedAppFromDesktop"
  | "onForkSavedAppInstallsChanged"
  | "forkPageData"
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

/** Which apps are installed on this computer (phase B); null until main answers. */
const [installs, setInstalls] = createSignal<SavedAppInstallState | null>(null);

export const savedApps = apps;
export const savedAppInstalls = installs;
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
  port.onForkSavedAppInstallsChanged(setInstalls);
  void refreshSavedApps();
  port.forkSavedAppInstalls().then(setInstalls, () => undefined);
}

async function refreshSavedApps(): Promise<void> {
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

/** openbotPage.data for one frame: the host names the page; main checks it declared data. */
export function pageDataHost(
  target: () => PageStateTarget | null,
): ((request: PageDataOperation) => Promise<PageStateReply>) | undefined {
  const port = savedAppsPort();
  if (!port) return undefined;
  return async (request) => {
    const shown = target();
    if (!shown) return { ok: false, error: "Live data is not available here." };
    return port.forkPageData({ ...request, target: shown });
  };
}

// ---- Install on this computer (phase B) ----

export function installedSavedApp(id: string) {
  return installs()?.apps.find((app) => app.id === id) ?? null;
}

const ICON_SIDE = 256;

/** The launcher's icon: the name's first letter on a rounded plate, like the app's mark on its card. */
async function drawSavedAppIcon(name: string): Promise<Uint8Array | null> {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = ICON_SIDE;
    canvas.height = ICON_SIDE;
    const context = canvas.getContext("2d");
    if (!context) return null;
    // The macOS icon grid: the plate is about 80% of the square, its corners about 22% of the plate.
    const inset = ICON_SIDE * 0.1;
    const side = ICON_SIDE - inset * 2;
    context.beginPath();
    context.roundRect(inset, inset, side, side, side * 0.225);
    const plate = context.createLinearGradient(0, inset, 0, inset + side);
    plate.addColorStop(0, "#34343a");
    plate.addColorStop(1, "#1f1f24");
    context.fillStyle = plate;
    context.fill();
    context.lineWidth = 3;
    context.strokeStyle = "rgba(255, 255, 255, 0.14)";
    context.stroke();
    context.fillStyle = "#ececf1";
    context.font = `600 ${Math.round(side * 0.5)}px -apple-system, "Segoe UI", system-ui, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    const letter = (Array.from(name.trim())[0] ?? "A").toUpperCase();
    context.fillText(letter, ICON_SIDE / 2, ICON_SIDE / 2 + side * 0.03);
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

export type SavedAppInstallAction = "install" | "uninstall" | "add-to-desktop" | "remove-from-desktop";

/** Runs one install action; the state that comes back is shown at once. */
export async function runSavedAppInstall(app: SavedApp, action: SavedAppInstallAction): Promise<SavedAppInstallReply> {
  const port = savedAppsPort();
  if (!port) throw new Error("Saved apps are not available here.");
  const icon = async () => ({ id: app.id, iconPng: await drawSavedAppIcon(app.name) });
  const reply =
    action === "install"
      ? await port.forkInstallSavedApp(await icon())
      : action === "add-to-desktop"
        ? await port.forkAddSavedAppToDesktop(await icon())
        : action === "uninstall"
          ? await port.forkUninstallSavedApp(app.id)
          : await port.forkRemoveSavedAppFromDesktop(app.id);
  setInstalls(reply.state);
  return reply;
}
