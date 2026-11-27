// Fork (docs/fork/FEATURES.md #123): main's wiring of the saved app installer: the real folders, Electron's shell,
// and the state the renderer shows. A development build installs only into OPENBOT_SAVED_APPS_INSTALL_DIR, so a test
// or a live check never writes into the person's own Applications or Desktop folder.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type {
  SavedAppInstallInput,
  SavedAppInstallReply,
  SavedAppInstallState,
} from "@openbot/contracts/fork-saved-apps";
import {
  createSavedAppInstaller,
  type InstallOutcome,
  SAVED_APP_FOLDER_NAME,
  SAVED_APP_HOST_BUNDLE_ID,
  type SavedAppInstaller,
  type SavedAppInstallerShell,
  validBundleId,
} from "./fork-app-install";

export const SAVED_APPS_INSTALL_DIR_ENV = "OPENBOT_SAVED_APPS_INSTALL_DIR";

function withoutTrash({ trashItem: _trashItem, ...shell }: SavedAppInstallerShell): SavedAppInstallerShell {
  return shell;
}

/** The running app's bundle id from its Info.plist (Contents/MacOS/<exe> → Contents/Info.plist). */
function hostBundleId(executable: string): string {
  try {
    const plist = readFileSync(resolve(executable, "..", "..", "Info.plist"), "utf8");
    const id = /<key>CFBundleIdentifier<\/key>\s*<string>([A-Za-z0-9.-]+)<\/string>/u.exec(plist)?.[1];
    return validBundleId(id) ? id : SAVED_APP_HOST_BUNDLE_ID;
  } catch {
    return SAVED_APP_HOST_BUNDLE_ID;
  }
}

export interface SavedAppInstallFolders {
  launchersDir: string;
  desktopDir: string | null;
  unavailable: "dev" | null;
  /** The override folder is in use (tests, live checks): removed launchers are deleted, not put in the Trash. */
  override: boolean;
}

/** Where launchers go: the override folder when set, else the real ones in a packaged build only. */
export function savedAppInstallFolders(input: {
  platform: NodeJS.Platform;
  override: string | undefined;
  packaged: boolean;
  home: string;
  appData: string;
  desktop: () => string | null;
}): SavedAppInstallFolders {
  const launchers = (base: string, mac: boolean) =>
    mac
      ? join(base, "Applications", SAVED_APP_FOLDER_NAME)
      : join(base, "Microsoft", "Windows", "Start Menu", "Programs", SAVED_APP_FOLDER_NAME);
  const override = input.override?.trim();
  if (override && isAbsolute(override))
    return {
      launchersDir: launchers(override, input.platform === "darwin"),
      desktopDir: join(override, "Desktop"),
      unavailable: null,
      override: true,
    };
  const base = input.platform === "darwin" ? input.home : input.appData;
  return {
    launchersDir: launchers(base, input.platform === "darwin"),
    desktopDir: input.packaged ? input.desktop() : null,
    unavailable: input.packaged ? null : "dev",
    override: false,
  };
}

export interface SavedAppInstallsDependencies {
  installer: SavedAppInstaller;
  /** The app's current name; null when it is not saved. */
  appName: (id: string) => string | null;
  changed: (state: SavedAppInstallState) => void;
}

/** What the renderer calls: each answer carries the state after it. */
export function createSavedAppInstalls({ installer, appName, changed }: SavedAppInstallsDependencies) {
  async function state(): Promise<SavedAppInstallState> {
    const unavailable = installer.unavailable();
    return { unavailable, apps: unavailable ? [] : await installer.installedApps() };
  }
  async function answer(outcome: Promise<InstallOutcome>): Promise<SavedAppInstallReply> {
    const result = await outcome;
    const after = await state();
    if (result.ok) changed(after);
    return result.ok ? { ok: true, state: after } : { ok: false, reason: result.reason, state: after };
  }
  const named = (input: SavedAppInstallInput) => {
    const name = appName(input.id);
    return name === null ? null : { id: input.id, name, iconPng: input.iconPng };
  };
  const notSaved = async (): Promise<SavedAppInstallReply> => ({
    ok: false,
    reason: "invalid-id",
    state: await state(),
  });
  return {
    state,
    install: (input: SavedAppInstallInput) => {
      const app = named(input);
      return app ? answer(installer.installApp(app)) : notSaved();
    },
    uninstall: (id: string) => answer(installer.uninstallApp(id)),
    addToDesktop: (input: SavedAppInstallInput) => {
      const app = named(input);
      return app ? answer(installer.addToDesktop(app)) : notSaved();
    },
    removeFromDesktop: (id: string) => answer(installer.removeFromDesktop(id)),
    /** `ids`: every saved app, as read; null (the list could not be read) removes nothing. */
    async cleanup(ids: readonly string[] | null): Promise<void> {
      const removed = await installer.cleanup(ids);
      if (removed.length) changed(await state());
    },
  };
}

export type SavedAppInstalls = ReturnType<typeof createSavedAppInstalls>;

export function createElectronSavedAppInstaller(input: {
  platform: NodeJS.Platform;
  stateDir: string;
  folders: SavedAppInstallFolders;
  shell: SavedAppInstallerShell;
  log: (line: string) => void;
}): SavedAppInstaller {
  return createSavedAppInstaller({
    platform: input.platform,
    stateDir: input.stateDir,
    launchersDir: input.folders.launchersDir,
    desktopDir: input.folders.desktopDir,
    executable: process.execPath,
    hostBundleId: input.platform === "darwin" ? hostBundleId(process.execPath) : SAVED_APP_HOST_BUNDLE_ID,
    unavailable: input.folders.unavailable,
    shell: input.folders.override ? withoutTrash(input.shell) : input.shell,
    log: input.log,
    run: (file, args) =>
      new Promise((done) => {
        execFile(file, args, { timeout: 20_000 }, (error) => done({ code: error ? 1 : 0 }));
      }),
  });
}
