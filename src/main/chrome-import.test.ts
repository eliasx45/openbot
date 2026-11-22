// Fork (docs/fork/FEATURES.md entry 32): the login-wall re-sync. A site that signed OpenBot out after
// the import must take Chrome's newer sign-in, on its own, without a Keychain question every time.
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Cookie, Cookies, CookiesSetDetails } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChromeImportService, isSignInUrl } from "./chrome-import";

const PASSWORD = "test-safe-storage";
const EPOCH_S = 11_644_473_600;
const chromeTime = (ms: number) => BigInt(Math.round((ms / 1000 + EPOCH_S) * 1_000_000));

function encrypt(host: string, value: string): Uint8Array {
  const key = pbkdf2Sync(PASSWORD, "saltysalt", 1003, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const plain = Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(value)]);
  return Buffer.concat([Buffer.from("v10"), cipher.update(plain), cipher.final()]);
}

/** A fake Chrome "Default" profile with one cookie table. */
function writeChrome(root: string, rows: { host: string; name: string; value: string; updated: number }[]): void {
  const dir = join(root, "Google", "Chrome", "Default");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(root, "Google", "Chrome", "Local State"),
    JSON.stringify({ profile: { info_cache: { Default: { name: "Your Chrome", user_name: "a@b.c" } } } }),
  );
  const file = join(dir, "Cookies");
  rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE meta (key TEXT, value TEXT); INSERT INTO meta VALUES ('version', '24');
    CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
      expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, has_expires INTEGER, samesite INTEGER,
      creation_utc INTEGER, last_update_utc INTEGER, top_frame_site_key TEXT)`);
  const insert = db.prepare("INSERT INTO cookies VALUES (?, ?, '', ?, '/', ?, 1, 1, 1, 0, ?, ?, '')");
  for (const row of rows) {
    insert.run(
      row.host,
      row.name,
      encrypt(row.host, row.value),
      chromeTime(Date.now() + 86_400_000),
      chromeTime(row.updated),
      chromeTime(row.updated),
    );
  }
  db.close();
}

/** An in-memory Electron cookie store that reports its changes like a session does. */
function fakeCookies() {
  const store = new Map<string, Cookie>();
  const listeners = new Set<(...args: unknown[]) => void>();
  const keyOf = (domain: string, name: string) => `${domain}\t${name}`;
  const emit = (cookie: Cookie, cause: string, removed: boolean) => {
    for (const listener of listeners) listener({}, cookie, cause, removed);
  };
  const cookies = {
    get: async () => [...store.values()],
    set: async (details: CookiesSetDetails) => {
      const domain = details.domain ?? new URL(details.url).hostname;
      const cookie = {
        name: details.name ?? "",
        value: details.value ?? "",
        domain,
        path: details.path ?? "/",
        sameSite: "unspecified",
      } satisfies Cookie;
      store.set(keyOf(domain, cookie.name), cookie);
      emit(cookie, "explicit", false);
    },
    flushStore: async () => undefined,
    on: (_event: string, listener: (...args: unknown[]) => void) => listeners.add(listener),
    removeListener: (_event: string, listener: (...args: unknown[]) => void) => listeners.delete(listener),
  };
  /** A page's Set-Cookie: OpenBot notes it as a change of its own. */
  const siteSets = (domain: string, name: string, value: string) => {
    const cookie: Cookie = { name, value, domain, path: "/", sameSite: "unspecified" };
    store.set(keyOf(domain, name), cookie);
    emit(cookie, "explicit", false);
  };
  // biome-ignore lint/nursery/noUnsafeTypeAssertion: the fake has only the members the service calls.
  return { cookies: cookies as unknown as Cookies, store, siteSets, keyOf };
}

const folders: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

async function setup() {
  // The import guards its own writes with a timer; the tests move past it without waiting.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const root = mkdtempSync(join(tmpdir(), "openbot-chrome-test-"));
  folders.push(root);
  const day = 86_400_000;
  writeChrome(root, [{ host: ".google.com", name: "SID", value: "old-session", updated: Date.now() - 40 * day }]);
  const fake = fakeCookies();
  const tab: { url: string; profileId: string | undefined; agentId: string } = {
    url: "https://gemini.google.com/app",
    profileId: "p1",
    agentId: "a1",
  };
  const reloadTab = vi.fn(async () => undefined);
  const readSafeStoragePassword = vi.fn(async () => PASSWORD);
  const service = createChromeImportService({
    dataDir: join(root, "data"),
    appSupport: root,
    profileCookies: () => fake.cookies,
    createProfile: async (name) => ({ id: "p1", name }),
    deleteProfile: async () => undefined,
    profileExists: (id) => id === "p1",
    tab: (id) => (id === "t1" ? tab : undefined),
    tabCookies: () => fake.cookies,
    agentProfileIds: () => ["p1"],
    reloadTab,
    readSafeStoragePassword,
  });
  await service.importProfiles({ profiles: [{ dir: "chrome:Default", sites: null }] });
  return { root, fake, tab, reloadTab, readSafeStoragePassword, service, day };
}

describe("isSignInUrl", () => {
  it.each([
    "https://accounts.google.com/v3/signin/accountchooser?continue=x",
    "https://accounts.google.com/ServiceLogin",
    "https://linear.app/login",
    "https://github.com/login?return_to=/",
    "https://app.example.com/sign-in",
    "https://example.com/users/sign_in",
    "https://login.microsoftonline.com/common",
  ])("sees a login wall at %s", (url) => expect(isSignInUrl(url)).toBe(true));

  it.each([
    "https://gemini.google.com/app",
    "https://linear.app/team/issue/LIN-1",
    "https://example.com/blog/login-tips-for-teams",
    "about:blank",
    "not a url",
  ])("sees no login wall at %s", (url) => expect(isSignInUrl(url)).toBe(false));
});

describe("login-wall re-sync", () => {
  it("takes Chrome's newer sign-in after the site signed OpenBot out", async () => {
    const { root, fake, tab, reloadTab, service, day } = await setup();
    expect(fake.store.get(fake.keyOf(".google.com", "SID"))?.value).toBe("old-session");
    // Google signs the copy out today; Chrome had signed in again 10 days ago.
    // The import's own writes are ignored for a second; the sign-out comes later.
    vi.advanceTimersByTime(1_000);
    fake.siteSets(".google.com", "SID", "signed-out");
    writeChrome(root, [{ host: ".google.com", name: "SID", value: "chrome-session", updated: Date.now() - 10 * day }]);

    // A plain re-sync keeps OpenBot's newer copy: newest wins.
    const plain = await service.resync("p1");
    expect(plain.kept).toBe(1);
    expect(fake.store.get(fake.keyOf(".google.com", "SID"))?.value).toBe("signed-out");

    // Not on a login wall: nothing happens.
    expect(await service.autoSignIn("t1")).toBe(false);

    // On the login wall, Chrome's sign-in wins and the tab reloads.
    tab.url = "https://accounts.google.com/v3/signin/accountchooser?continue=https://gemini.google.com/app";
    expect(await service.autoSignIn("t1")).toBe(true);
    expect(fake.store.get(fake.keyOf(".google.com", "SID"))?.value).toBe("chrome-session");
    expect(reloadTab).toHaveBeenCalledTimes(1);

    // The same wall again soon: no second try, no reload loop.
    expect(await service.autoSignIn("t1")).toBe(false);
    expect(reloadTab).toHaveBeenCalledTimes(1);
  });

  it("does not reload when Chrome has nothing newer", async () => {
    const { tab, reloadTab, service } = await setup();
    tab.url = "https://accounts.google.com/ServiceLogin";
    expect(await service.autoSignIn("t1")).toBe(false);
    expect(reloadTab).not.toHaveBeenCalled();
  });

  it("asks the Keychain no more after an automatic read fails", async () => {
    const { tab, readSafeStoragePassword, service, root } = await setup();
    rmSync(join(root, "Google", "Chrome", "Default", "Cookies"));
    tab.url = "https://accounts.google.com/ServiceLogin";
    await expect(service.autoSignIn("t1")).rejects.toThrow();
    tab.url = "https://linear.app/login";
    expect(await service.autoSignIn("t1")).toBe(false);
    expect(readSafeStoragePassword).toHaveBeenCalledTimes(1);
  });

  it("the card button also lets Chrome win over a signed-out copy", async () => {
    const { root, fake, tab, service, day } = await setup();
    // The import's own writes are ignored for a second; the sign-out comes later.
    vi.advanceTimersByTime(1_000);
    fake.siteSets(".google.com", "SID", "signed-out");
    writeChrome(root, [{ host: ".google.com", name: "SID", value: "chrome-session", updated: Date.now() - 10 * day }]);
    tab.url = "https://accounts.google.com/ServiceLogin";
    const result = await service.signInTab("t1");
    expect(result.counts.updated).toBe(1);
    expect(fake.store.get(fake.keyOf(".google.com", "SID"))?.value).toBe("chrome-session");
  });
});
