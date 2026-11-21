// @vitest-environment node
// Fork (docs/fork/FEATURES.md entry 32): the browser sign-in import reads macOS browser folders and the
// macOS Keychain. On Windows and Linux the profile list says the import is not supported there, instead
// of saying that no browser profile is on the computer.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeChromeProfileList } from "@openbot/contracts/ipc";
import { afterEach, describe, expect, it } from "vitest";
import { type ChromeImportDependencies, createChromeImportService } from "./chrome-import";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A fake Application Support folder with one Chrome profile in its `Local State`. */
function fakeAppSupport(): string {
  const root = mkdtempSync(join(tmpdir(), "openbot-chrome-import-test-"));
  roots.push(root);
  const chrome = join(root, "Google", "Chrome");
  mkdirSync(chrome, { recursive: true });
  writeFileSync(
    join(chrome, "Local State"),
    JSON.stringify({ profile: { info_cache: { Default: { name: "Work", user_name: "", active_time: 1 } } } }),
  );
  return root;
}

function service(platform: NodeJS.Platform, appSupport: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "openbot-chrome-import-data-"));
  roots.push(dataDir);
  const deps: ChromeImportDependencies = {
    dataDir,
    appSupport,
    platform,
    profileCookies: () => {
      throw new Error("Listing profiles opens no cookie store.");
    },
    createProfile: async (name) => ({ id: "p1", name }),
    deleteProfile: async () => {},
    profileExists: () => false,
    tab: () => undefined,
    tabCookies: () => undefined,
    agentProfileIds: () => [],
    reloadTab: async () => {},
  };
  return createChromeImportService(deps);
}

describe("listProfiles by platform", () => {
  it("says the import is not supported on Windows, even with a browser folder present", () => {
    expect(service("win32", fakeAppSupport()).listProfiles()).toEqual({
      available: false,
      supported: false,
      profiles: [],
    });
  });

  it("says the import is not supported on Linux", () => {
    expect(service("linux", fakeAppSupport()).listProfiles()).toMatchObject({ available: false, supported: false });
  });

  it("lists the profiles on macOS", () => {
    const list = service("darwin", fakeAppSupport()).listProfiles();
    expect(list.supported).toBe(true);
    expect(list.available).toBe(true);
    expect(list.profiles.map((profile) => profile.dir)).toEqual(["chrome:Default"]);
  });

  it("says no profile is there on macOS when no browser folder exists", () => {
    const empty = mkdtempSync(join(tmpdir(), "openbot-chrome-import-empty-"));
    roots.push(empty);
    expect(service("darwin", empty).listProfiles()).toEqual({ available: false, supported: true, profiles: [] });
  });
});

describe("decodeChromeProfileList", () => {
  it("keeps `supported` and treats a list without it as supported", () => {
    expect(decodeChromeProfileList({ available: false, supported: false, profiles: [] }).supported).toBe(false);
    expect(decodeChromeProfileList({ available: false, profiles: [] }).supported).toBe(true);
  });
});
