# What the fork adds: a log to rebuild it anywhere

Everything this fork does that upstream OpenBot doesn't, written so it can be rebuilt in another app: what Elias gets, why, how it works independent of OpenBot's code, where it lives here, and how to check it. Same format as Codync's `docs/fork/FEATURES.md`.

**Agents: every fork change adds or updates its entry here in the same commit.** Newest last. Build tooling and fixes for this Mac count too.

Skipped features, to pick up later: [LATER.md](LATER.md).

---

## 1. No auto-updates

- **Get:** the app never checks for, downloads or installs an upstream release.
- **Why:** an official release would silently replace the fork's build and every change in this file (Codync lesson, its entry 2).
- **How (portable):** one compile-time switch that the updater's enable condition reads first; keep the upstream updater code so merges stay simple. With the switch off the app uses its own "updates unsupported" path (as for unpacked builds), so no electron-updater module loads.
- **Here:** `updatesAllowed = false` in `src/main/fork.ts`, read as `forkUpdatesAllowed &&` at the top of `updatesEnabled` in `src/main/application-services.ts`. `app-update.yml` still ships (unused).
- **Check:** `grep -n 'forkUpdatesAllowed &&' src/main/application-services.ts`; Settings shows updates as unavailable; no `~/Library/Caches/openbot-updater/pending/update.zip` appears after an upstream release.

## 2. Dock launcher: one click builds `main` if it changed, installs, opens

- **Get:** **OpenBot Launcher** in the Dock (like the Codync, Ghostex, FigCraft and EffectCraft launchers). Click: if `main` has a new commit since the last install, a small window builds it (Stop / close / ⌘Q cancel the whole build), replaces `/Applications/OpenBot.app` and opens it; otherwise it just opens OpenBot. Never quits or replaces a running OpenBot.
- **Why:** Elias's apps all rebuild from `main` this way; agents commit without building, and the next launch builds once.
- **How (portable):** a shell script plus a tiny Swift AppKit window that runs it and shows the log's last line (only dyld's `Reason:` / `Referenced from:` / `dyld[` notes are skipped; indented progress lines stay). Stamp file = commit last installed; a `mkdir` lock so one build runs; the build runs in its own process group (`set -m`) so Stop kills every child; build functions are never called inside `&&`/`||` (there `set -e` is silently ignored). Install by moving the bundle (old one moved aside first, then deleted: one copy only). A build made while the app runs (`--build`) is kept with its commit as the next install, so the next click with the app quit installs it at once instead of building again. The launcher is signed with the same Developer ID as the app, so after the first install macOS lets it replace the app without the App Management grant.
- **Here:** `scripts/fork/app.sh`, `scripts/fork/launcher.swift`, `scripts/fork/install-dock-app.sh` (compiles to `~/Applications/OpenBot Launcher.app`, bundle id `com.eliasx45.openbot-fork.launcher`, pins it once). State and log in `build/fork-launcher/`.
- **Check:** quit OpenBot, make a commit, click: builds, installs, opens. Click again with no new commit: opens at once. With OpenBot open: `scripts/fork/app.sh --build`, quit, click: installs in a second.

## 3. Fast launcher builds: this Mac only, no timestamp, patch what changed

- **Get:** a full build takes a few minutes; a commit that only changes the app's JavaScript or resources installs in well under that; a docs-only commit builds nothing.
- **Why:** Codync lessons (its entry 5): universal builds, slow release profiles and per-file timestamp calls made rebuilds 5½ min.
- **How (portable):** build only the machine's architecture (`--arm64`). Nothing native compiles here (voice runtime, remote desktop runtime and Cua driver are pinned downloads that each skip when present), so no LTO profile to override. Sign without a secure timestamp (`-c.mac.timestamp=none`). `bun install` only when the lockfile, a `package.json` or a patch changed (hash stamp). Diff the installed commit against the new one and sort each path by what it is compiled into: `src/`, `packages/`, the Vite config, `scripts/agent-runtime-lock*` (imported by `src/main`) → the asar; `resources/` → plain files in Resources and the asar (`src/` imports `resources/agent-import/*/SKILL.md?raw` and `resources/plugin-catalog/catalog.json`); tests, docs, other apps (mobile, API, bots), CI and the launcher → nothing; dependencies, runtime locks, `electron-builder.yml`, the fork entitlements and anything unknown → full build. A patch clones the installed app (APFS `cp -Rc`, instant), swaps in `app.asar`, `app.asar.unpacked` (its native addon re-signed) and the `Info.plist` that carries the asar hash (`ElectronAsarIntegrity`, from an unsigned electron-builder run with the same flags), re-signs the outer bundle and checks `codesign --verify --deep --strict`; any failure falls back to a full build.
- **Here:** `changes`, `patch`, `steps`, `install_deps` in `scripts/fork/app.sh`.
- **Check:** `build/fork-launcher/build.log`: first line names the parts (`full`, `( js)`, `( res js)`, `none`), last lines `built in N s` and `installed`.

## 4. Signed with Elias's Developer ID: macOS permissions survive rebuilds

- **Get:** Screen Recording, Accessibility, Microphone and Automation are granted once and stay granted across rebuilds.
- **Why:** ad-hoc or unsigned builds look like a new app to macOS each build, so grants vanished (Codync lesson, its entry 6).
- **How (portable):** sign every build with one stable certificate (full name `Developer ID Application: mohamed elias hamadouche (GQQBT37P3D)`: the short name is ambiguous, an Apple Distribution certificate has it too), hardened runtime, the app's entitlements; no notarizing. Drop entitlements that need the original team's provisioning profile (`com.apple.developer.associated-domains`, `com.apple.developer.team-identifier`): without the profile macOS refuses to start an app that claims them. Set `ElectronTeamID` to the new team. Nested binaries signed by a third party (Cua driver) keep their own signature. Grants made for the original signature (team `ZTRDTUL87R`) must be removed (−) and granted again once; the keychain item "OpenBot Safe Storage" asks once ("Always Allow").
- **Here:** `identity`, `entitlements`, `builder_flags` in `scripts/fork/app.sh`; `scripts/fork/entitlements.mac.plist`.
- **Check:** `codesign -dv /Applications/OpenBot.app` shows `TeamIdentifier=GQQBT37P3D`; after a rebuild Computer Use still works without a new prompt.

## 5. Same app identity and data as the release, with a rollback

- **Get:** the fork opens Elias's existing data, agents (Rasta, Booty, Shelf) and settings; the official release can be put back.
- **Why:** the fork replaces the installed release in place.
- **How (portable):** keep the bundle id (`app.openbot.desktop`) and product name, so a packaged run's userData stays `~/Library/Application Support/OpenBot` and the agent workspaces stay in `~/OpenBot`. Before the first install over a build signed by another team, zip that app (`ditto -c -k --keepParent`) and copy its database with `sqlite3 .backup` (upstream `main` migrates the schema forward; an older release refuses a newer database).
- **Here:** `backup_official` in `scripts/fork/app.sh` → `build/official-<version>.zip`, `build/official-<version>-openbot.db`. Rollback steps in [README.md](README.md#data-signature-rollback).
- **Check:** after the first install the agents and chats are there; both backup files exist.
