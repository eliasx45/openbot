// Fork (docs/fork/FEATURES.md #123): installing a saved app on this computer, in temporary folders only.
import { execFile } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSavedAppInstaller,
  icoFromPng,
  launcherName,
  MAC_ID_KEY,
  macInfoPlist,
  macLauncherScript,
  macPlistAppId,
  type SavedAppInstallerOptions,
  type ShortcutOptions,
  savedAppBundleId,
  savedAppKey,
} from "./fork-app-install";

const ID = "app_AAAAAAAAAAAAAAAA";
const ID2 = "app_BBBBBBBBBBBBBBBB";
const ID3 = "app_CCCCCCCCCCCCCCCC";
const HOST = "app.openbot.desktop";

const dirs: string[] = [];
function tempRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "openbot-app-install-")));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** A plain square PNG of one colour. */
function png(side = 256): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc((side * 4 + 1) * side);
  for (let y = 0; y < side; y += 1)
    for (let x = 0; x < side; x += 1) rows.set([0x4f, 0x5b, 0xd5, 0xff], y * (side * 4 + 1) + 1 + x * 4);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(rows)),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

const run = (file: string, args: string[]) =>
  new Promise<{ code: number }>((resolve) => {
    execFile(file, args, { timeout: 20_000 }, (error) => resolve({ code: error ? 1 : 0 }));
  });

function mac(root: string, extra: Partial<SavedAppInstallerOptions> = {}) {
  const trashed: string[] = [];
  const installer = createSavedAppInstaller({
    platform: "darwin",
    stateDir: join(root, "state"),
    launchersDir: join(root, "Applications", "OpenBot Apps"),
    desktopDir: join(root, "Desktop"),
    executable: "/Applications/OpenBot.app/Contents/MacOS/OpenBot",
    hostBundleId: HOST,
    unavailable: null,
    run: async () => ({ code: 1 }),
    shell: {
      trashItem: async (path) => {
        trashed.push(path);
        rmSync(path, { recursive: true, force: true });
      },
    },
    ...extra,
  });
  return { installer, trashed, apps: join(root, "Applications", "OpenBot Apps"), desktop: join(root, "Desktop") };
}

describe("launcher text", () => {
  it("writes the plist with the id marker, a bundle id from the app key, and escaped XML", () => {
    const plist = macInfoPlist({ id: ID, name: `Tom & Jerry's <Notes>`, hostBundleId: HOST, icon: true });
    expect(plist).toContain("<string>Tom &amp; Jerry&apos;s &lt;Notes&gt;</string>");
    expect(plist).toContain(`<key>CFBundleIdentifier</key>\n  <string>${HOST}.savedapp.${savedAppKey(ID)}</string>`);
    expect(plist).toContain("<key>CFBundleExecutable</key>\n  <string>launcher</string>");
    expect(plist).toContain("<key>CFBundleIconFile</key>\n  <string>AppIcon</string>");
    expect(plist).toContain("<key>CFBundlePackageType</key>\n  <string>APPL</string>");
    expect(plist).toContain("<key>LSUIElement</key>\n  <true/>");
    expect(plist).toContain("<key>NSHighResolutionCapable</key>\n  <true/>");
    expect(plist).toContain(`<key>${MAC_ID_KEY}</key>\n  <string>${ID}</string>`);
    expect(macPlistAppId(plist)).toBe(ID);
    expect(savedAppKey(ID)).toMatch(/^[0-9a-f]{16}$/u);
    expect(() => macInfoPlist({ id: "app_../../x", name: "x", hostBundleId: HOST, icon: false })).toThrow();
  });

  it("writes the exact launcher script, single-quoted, and refuses a bad host bundle id", () => {
    expect(macLauncherScript({ id: ID, hostBundleId: HOST })).toBe(
      `#!/bin/sh\n/usr/bin/open -b '${HOST}' 'openbot://app/${ID}?window=1' 2>/dev/null || exec /usr/bin/open 'openbot://app/${ID}?window=1'\n`,
    );
    expect(macLauncherScript({ id: ID, hostBundleId: "x'; rm -rf ~; '" })).toContain(`-b '${HOST}'`);
    expect(savedAppBundleId(ID, "bad id")).toBe(`${HOST}.savedapp.${savedAppKey(ID)}`);
    expect(() => macLauncherScript({ id: "app_'; rm -rf ~'", hostBundleId: HOST })).toThrow();
  });

  it("cleans names like the file systems need them", () => {
    expect(launcherName("  My/App: v2?  ")).toBe("My App v2");
    expect(launcherName("..hidden.")).toBe("hidden");
    expect(launcherName("CON")).toBe("CON_");
    expect(launcherName("a\u202Eb\u200Bc")).toBe("abc");
    expect(launcherName("")).toBe("App");
    expect(launcherName("x".repeat(200))).toHaveLength(64);
  });

  it("wraps a PNG in an .ico", () => {
    const ico = icoFromPng(png(32));
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt8(6)).toBe(32);
    expect(ico.subarray(22, 26).toString("latin1")).toBe("\x89PNG");
  });
});

describe("macOS install", () => {
  it.skipIf(process.platform !== "darwin")(
    "builds a valid bundle with an icon, staged then renamed into place",
    async () => {
      const root = tempRoot();
      const { installer, apps } = mac(root, { run });
      const result = await installer.installApp({ id: ID, name: "Counter", iconPng: png() });
      expect(result).toEqual({ ok: true, app: { id: ID, name: "Counter", desktop: false } });
      const bundle = join(apps, "Counter.app");
      expect(readdirSync(apps)).toEqual(["Counter.app"]);
      const plist = join(bundle, "Contents", "Info.plist");
      expect((await run("/usr/bin/plutil", ["-lint", plist])).code).toBe(0);
      expect(macPlistAppId(readFileSync(plist, "utf8"))).toBe(ID);
      const launcher = join(bundle, "Contents", "MacOS", "launcher");
      expect(statSync(launcher).mode & 0o777).toBe(0o755);
      expect(readFileSync(launcher, "utf8")).toBe(macLauncherScript({ id: ID, hostBundleId: HOST }));
      expect(readFileSync(join(bundle, "Contents", "PkgInfo"), "utf8")).toBe("APPL????");
      const icns = readFileSync(join(bundle, "Contents", "Resources", "AppIcon.icns"));
      expect(icns.toString("latin1", 0, 4)).toBe("icns");
      expect(icns.readUInt32BE(4)).toBe(icns.length);
      expect(existsSync(join(root, "state", "work"))).toBe(false);
      const manifest = JSON.parse(readFileSync(join(root, "state", "installed.json"), "utf8"));
      expect(manifest.apps[ID]).toEqual({ name: "Counter", files: [{ path: bundle, kind: "bundle" }] });
      expect(statSync(join(root, "state", "installed.json")).mode & 0o777).toBe(0o600);
      expect(await installer.installedApps()).toEqual([{ id: ID, name: "Counter", desktop: false }]);
    },
  );

  it("leaves out the icon when sips fails, and never touches a bundle without its id", async () => {
    const root = tempRoot();
    const { installer, apps, trashed } = mac(root);
    mkdirSync(join(apps, "Notes.app", "Contents"), { recursive: true });
    writeFileSync(join(apps, "Notes.app", "Contents", "Info.plist"), "<plist>the person's own</plist>");
    const result = await installer.installApp({ id: ID, name: "Notes", iconPng: png() });
    expect(result).toEqual({ ok: true, app: { id: ID, name: "Notes 2", desktop: false } });
    const plist = readFileSync(join(apps, "Notes 2.app", "Contents", "Info.plist"), "utf8");
    expect(plist).not.toContain("CFBundleIconFile");
    // The person's bundle under the name stays, also through uninstall and cleanup.
    expect(await installer.uninstallApp(ID)).toEqual({ ok: true, removed: true });
    expect(trashed).toEqual([join(apps, "Notes 2.app")]);
    await installer.cleanup([]);
    expect(readdirSync(apps)).toEqual(["Notes.app"]);
    expect(readFileSync(join(apps, "Notes.app", "Contents", "Info.plist"), "utf8")).toContain("the person's own");
  });

  it("gives two apps of the same name their own files", async () => {
    const root = tempRoot();
    const { installer, apps } = mac(root);
    await installer.installApp({ id: ID, name: "Notes" });
    expect(await installer.installApp({ id: ID2, name: "notes" })).toMatchObject({ app: { name: "notes 2" } });
    // Installing again keeps each name.
    expect(await installer.installApp({ id: ID, name: "Notes" })).toMatchObject({ app: { name: "Notes" } });
    expect(readdirSync(apps).sort()).toEqual(["Notes.app", "notes 2.app"]);
  });

  it("refuses a symbolic link in place of a launcher", async () => {
    const root = tempRoot();
    const { installer, apps, trashed } = mac(root);
    await installer.installApp({ id: ID, name: "Linked" });
    const bundle = join(apps, "Linked.app");
    const elsewhere = join(root, "elsewhere.app");
    // The real bundle moved away and a link to it put in its place: the link is not this app's launcher.
    writeFileSync(join(root, "keep.txt"), "x");
    rmSync(bundle, { recursive: true });
    mkdirSync(join(elsewhere, "Contents"), { recursive: true });
    writeFileSync(
      join(elsewhere, "Contents", "Info.plist"),
      macInfoPlist({ id: ID, name: "x", hostBundleId: HOST, icon: false }),
    );
    symlinkSync(elsewhere, bundle);
    expect(await installer.installedApps()).toEqual([]);
    expect(await installer.uninstallApp(ID)).toEqual({ ok: true, removed: true, left: [bundle] });
    expect(trashed).toEqual([]);
    expect(lstatSync(bundle).isSymbolicLink()).toBe(true);
    expect(existsSync(join(elsewhere, "Contents", "Info.plist"))).toBe(true);
    // A new install does not write through it either.
    expect(await installer.installApp({ id: ID, name: "Linked" })).toMatchObject({ app: { name: "Linked 2" } });
  });

  it("refuses a launcher folder that is a symbolic link", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "Applications"));
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "Applications", "OpenBot Apps"));
    const { installer } = mac(root);
    expect(await installer.installApp({ id: ID, name: "X" })).toEqual({ ok: false, reason: "failed" });
    expect(readdirSync(join(root, "real"))).toEqual([]);
  });

  it("renames by writing the new bundle, then removing the old, the Desktop copy too", async () => {
    const root = tempRoot();
    const { installer, apps, desktop } = mac(root);
    mkdirSync(desktop);
    await installer.installApp({ id: ID, name: "Old", desktop: true });
    expect(readdirSync(desktop)).toEqual(["Old.app"]);
    expect(await installer.installApp({ id: ID, name: "New" })).toEqual({
      ok: true,
      app: { id: ID, name: "New", desktop: true },
    });
    expect(readdirSync(apps)).toEqual(["New.app"]);
    expect(readdirSync(desktop)).toEqual(["New.app"]);
    expect(macPlistAppId(readFileSync(join(desktop, "New.app", "Contents", "Info.plist"), "utf8"))).toBe(ID);
  });

  it("adds to the Desktop (installing first), never creates the Desktop folder, and removes only its copy", async () => {
    const root = tempRoot();
    const { installer, apps, desktop } = mac(root);
    expect(await installer.addToDesktop({ id: ID, name: "Desk" })).toEqual({ ok: false, reason: "no-desktop" });
    expect(existsSync(desktop)).toBe(false);
    mkdirSync(desktop);
    writeFileSync(join(desktop, "notes.txt"), "mine");
    expect(await installer.addToDesktop({ id: ID2, name: "Desk" })).toEqual({
      ok: true,
      app: { id: ID2, name: "Desk", desktop: true },
    });
    expect(readdirSync(apps)).toContain("Desk.app");
    expect(readdirSync(desktop).sort()).toEqual(["Desk.app", "notes.txt"]);
    expect(await installer.removeFromDesktop(ID2)).toEqual({ ok: true, removed: true });
    expect(readdirSync(desktop)).toEqual(["notes.txt"]);
    expect(await installer.installedApps()).toEqual([{ id: ID2, name: "Desk", desktop: false }]);
    expect(await installer.addToDesktop({ id: ID2, name: "Desk" })).toMatchObject({ app: { desktop: true } });
    expect(await installer.installedApps()).toEqual([{ id: ID2, name: "Desk", desktop: true }]);
  });

  it("cleans up the launchers of apps no longer saved, and nothing when the list failed", async () => {
    const root = tempRoot();
    const { installer, apps } = mac(root);
    await installer.installApp({ id: ID, name: "One" });
    await installer.installApp({ id: ID2, name: "Two" });
    await installer.installApp({ id: ID3, name: "Three" });
    mkdirSync(join(apps, `.openbot-${savedAppKey(ID)}.staging`));
    expect(await installer.cleanup(null)).toEqual([]);
    expect(
      readdirSync(apps)
        .filter((name) => !name.startsWith("."))
        .sort(),
    ).toEqual(["One.app", "Three.app", "Two.app"]);
    expect((await installer.cleanup([ID2])).sort()).toEqual([ID, ID3].sort());
    expect(readdirSync(apps)).toEqual(["Two.app"]);
  });

  it("is off when unavailable, and refuses an invalid id before any file", async () => {
    const root = tempRoot();
    const dev = mac(root, { unavailable: "dev" }).installer;
    expect(dev.unavailable()).toBe("dev");
    expect(await dev.installApp({ id: ID, name: "X" })).toEqual({ ok: false, reason: "unavailable" });
    expect(await dev.installedApps()).toEqual([]);
    const linux = createSavedAppInstaller({
      platform: "linux",
      stateDir: join(root, "s"),
      launchersDir: join(root, "l"),
      desktopDir: null,
      executable: "/usr/bin/openbot",
      hostBundleId: HOST,
      unavailable: null,
    });
    expect(linux.unavailable()).toBe("linux");
    const { installer } = mac(root);
    for (const id of ["app_../../../etc", "la_AAAAAAAAAAAAAAAA", "app_AAAA'AAAAAAAAAAA"])
      expect(await installer.installApp({ id, name: "X" })).toEqual({ ok: false, reason: "invalid-id" });
    expect(existsSync(join(root, "Applications"))).toBe(false);
  });
});

describe("Windows install", () => {
  function windows(root: string) {
    const written = new Map<string, ShortcutOptions>();
    const installer = createSavedAppInstaller({
      platform: "win32",
      stateDir: join(root, "state"),
      launchersDir: join(root, "Start Menu", "Programs", "OpenBot Apps"),
      desktopDir: join(root, "Desktop"),
      executable: "C:\\Program Files\\OpenBot\\OpenBot.exe",
      hostBundleId: HOST,
      unavailable: null,
      shell: {
        writeShortcutLink: (path, _operation, options) => {
          writeFileSync(path, "lnk");
          written.set(path, options);
          return true;
        },
        readShortcutLink: (path) => written.get(path) ?? {},
      },
    });
    return { installer, written, start: join(root, "Start Menu", "Programs", "OpenBot Apps") };
  }

  it("writes a Start menu shortcut with the link, an .ico and its own taskbar id; Desktop copy alike", async () => {
    const root = tempRoot();
    const { installer, written, start } = windows(root);
    mkdirSync(join(root, "Desktop"));
    expect(await installer.installApp({ id: ID, name: "Counter", iconPng: png(64), desktop: true })).toEqual({
      ok: true,
      app: { id: ID, name: "Counter", desktop: true },
    });
    const shortcut = written.get(join(start, "Counter.lnk"));
    const ico = join(root, "state", "icons", `${savedAppKey(ID)}.ico`);
    expect(shortcut).toEqual({
      target: "C:\\Program Files\\OpenBot\\OpenBot.exe",
      args: `openbot://app/${ID}?window=1`,
      description: "Counter",
      icon: ico,
      iconIndex: 0,
      appUserModelId: `${HOST}.savedapp.${savedAppKey(ID)}`,
    });
    expect(readFileSync(ico).readUInt16LE(2)).toBe(1);
    expect(written.has(join(root, "Desktop", "Counter.lnk"))).toBe(true);
    // A shortcut the person made under the same name is not this app's.
    writeFileSync(join(start, "Other.lnk"), "theirs");
    expect(await installer.installApp({ id: ID2, name: "Other" })).toMatchObject({ app: { name: "Other 2" } });
    expect(await installer.uninstallApp(ID)).toEqual({ ok: true, removed: true });
    expect(readdirSync(start).sort()).toEqual(["Other 2.lnk", "Other.lnk"]);
    expect(readdirSync(join(root, "Desktop"))).toEqual([]);
  });
});
