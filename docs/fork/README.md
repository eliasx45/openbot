# Elias's fork of OpenBot

This repository (`eliasx45/openbot`) is a personal fork of [nightly-labs/openbot](https://github.com/nightly-labs/openbot) (PolyForm Noncommercial 1.0.0). It is built and used by one person on his own Mac. The decisions here override upstream behaviour on purpose; do not "fix" them back because upstream code, docs or tests expect otherwise.

**[FEATURES.md](FEATURES.md)** logs everything the fork adds (features, build tooling, fixes) as a portable spec. Every fork change adds or updates its entry there in the same commit.

**[LATER.md](LATER.md)** lists features skipped for now (relay/cloud features from Codync, fallback chain, new clients), with the gaps they'd close.

Fork switches live in `src/main/fork.ts` (read by upstream code at one place each), so merges stay small.

## Syncing upstream

```bash
git fetch upstream
git merge upstream/main
```

Before committing the merge: `grep -n 'forkUpdatesAllowed &&' src/main/application-services.ts` must still find the updater gate (upstream's AGENTS.md allows no unit tests, so there is no test for it), then click the launcher.

### Upstream merge 18 Nov 2026 (v0.73.0, 690 commits, up to 0dcec6b44)

- 92 files conflicted; each kept upstream's change plus the fork's. The commit message lists the judgement calls.
- Database: upstream froze each migration in `src/backend/migrations/` and removed `LATEST_SCHEMA_SQL` (#10806, #11633): a new install runs every migration from the version 8 baseline. The fork's thread child indexes stay out of the numbered migrations: `applyForkSchema` (in `openbot-database-schema.ts`) adds them after a full upgrade, and `repairForkVersion59` still repairs a database that the fork's old migration 59 took to version 59. Migrations 62 to 65 are upstream's. The parity test and `thread-event-compaction-migration.test.ts` leave out `FORK_SCHEMA_INDEX_NAMES`.
- Fork behaviour re-applied on new upstream code: backup models switch only at a usage limit (FEATURES #81, against #8406, #10386, #11256, #11332); a refresh waits for background work also after an MCP change (FEATURES #46, against #10335); WhatsApp Watch on upstream's 90-day history, HD copy, held-message and `#allowSender` paths (#68); Claude Code MCP servers moved with upstream's MCP panel into Marketplace › Apps (#9, against #10423); one usage gauge in the rail (#44, upstream's "+N" ring not taken); ⌘↩ queue and closing stale cards on upstream's steer-before-question order for Claude (#57, #63).

### Upstream merge 12 Nov 2026 (v0.68.0+, 130 commits, #7462–#8247)

- 29 files conflicted; each kept upstream's change plus the fork's. The commit message lists them.
- Fork behaviour re-applied on new upstream code: `ask_ui` keeps choice and form cards for agents (FEATURES #74, against #7623); the New menu moved into the fork's sidebar top bar (#51, against #7830); the usage button sits in the rail's new end group (#44); selection notes and the per-account sign-in button moved into the composer's new stack cards (#35, #59, against #7740); the fork's "hidden agent" checks read upstream's `paused` set (#7825: a hidden agent keeps working).
- Upstream changes Elias sees: page rail with the server menu and one top row per page (#7830), pill message input (#7740), a message to a working agent steers it by default (#7826; ⌘↩ still queues), hidden agents keep working (#7825; at the first start the active routines of a hidden agent are turned off once; Elias had no hidden agent on 12 Nov), Claude backup model and account pools (#7556, #7698, #7841, #7891), `[SILENT]` quiet routine runs (#7561), Electron 45.3.0 (#7735), cua-driver 0.41.3 (#7833), migration 61 (pinned thread messages).
- The fork's thread child indexes stay out of the numbered migrations (`applyForkSchema`); `thread-child-index-migration.test.ts` now expects version 61.

## Build

The launcher runs upstream's `bun run package` with these differences:

```bash
bun install --frozen-lockfile            # only when bun.lock / a package.json / patches/ changed
bun run voice:prepare-runtime            # pinned downloads, each skipped when already there
bun run prepare:remote-desktop-runtime
bun run verify:remote-desktop-runtime
bun run prepare:cua-driver
bun run build                            # electron-vite
bunx electron-builder --dir --mac --arm64 --publish never \
  -c.mac.notarize=false -c.mac.timestamp=none \
  "-c.mac.identity=mohamed elias hamadouche (GQQBT37P3D)"   # no type prefix: electron-builder refuses it \
  -c.mac.entitlements=scripts/fork/entitlements.mac.plist \
  -c.mac.extendInfo.ElectronTeamID=GQQBT37P3D
```

- Needs node >= 24 (`/opt/homebrew/bin` first on PATH; an nvm node 20 breaks the build) and bun.
- Nothing native compiles: the voice runtime, remote desktop runtime and Cua driver are pinned downloads. The Cua driver keeps Cua AI's own signature (`signIgnore` upstream).
- `scripts/fork/entitlements.mac.plist` is upstream's `build/entitlements.mac.plist` without `associated-domains` and the official `team-identifier`: those need the official team's provisioning profile, and without it macOS refuses to start the app. So `openbot.run` universal links don't open the fork.
- Electron comes from `@electron/get`'s cache (`~/Library/Caches/electron`), filled by `bun install`. If electron-builder's download ever stalls, put `electron-v<version>-darwin-arm64.zip` (checked against `SHASUMS256.txt`) in `build/electron-dist/` and add `-c.electronDist=build/electron-dist`.

## The Dock launcher

Click **OpenBot** in the Dock: one icon. `scripts/fork/app.sh` wraps a small starter into every install (`scripts/fork/launcher.swift` becomes `Contents/MacOS/OpenBot`; Electron's binary moves to `OpenBot-app`, signed with the same Developer ID, identifier `app.openbot.desktop` and entitlements, so its designated requirement equals the app's and macOS grants stay). The starter checks `app.sh --stale`: `ready` → it `execv`s into Electron in the same process; `stale` → the window below runs `app.sh --update`, then OpenBot reopens itself. "Open Without Updating" skips a build; no build in the first 5 minutes after a restart (login item). (Before 20 Nov 2026: a separate `~/Applications/OpenBot Launcher.app`, so the Dock showed the launcher's pin and the running app; the first install with the starter unpins it and moves it to the Trash via `scripts/fork/install-dock-app.sh`.)

- `main` unchanged since the last install (`build/fork-launcher/built-commit`): opens OpenBot at once.
- `main` changed: a small window builds it (Stop, closing the window or ⌘Q stop the whole build), moves the new bundle to `/Applications/OpenBot.app` and opens it. One build at a time (a `mkdir` lock).
- OpenBot running: never quit or replaced. `scripts/fork/app.sh --build` builds while it runs and keeps the result as the next install (`build/fork-launcher/OpenBot.app`); the next click with OpenBot quit installs it without building again.
- Commits that touch only `src/` / `packages/` are patched: an APFS clone of the installed app gets the new `app.asar`, `app.asar.unpacked` and `Info.plist` (the asar hash), `resources/` changes are synced in, then the bundle is re-signed and checked with `codesign --verify --deep --strict`; any failure is a full build. Docs, tests, other apps (mobile, API) and the launcher itself build nothing.
- Log: `build/fork-launcher/build.log` (first line names the parts: `full`, `( js)`, `( res js)`, `none`).

## Data, signature, rollback

- Same bundle id (`app.openbot.desktop`) and name as the release, so the fork opens the same data: `~/Library/Application Support/OpenBot` (userData is `appData/OpenBot` for a packaged app) and the agents in `~/OpenBot`.
- Signed with Elias's Developer ID (team `GQQBT37P3D`), hardened runtime, not notarized. macOS grants follow the signature, so they survive rebuilds. Grants given to the official app (team `ZTRDTUL87R`) must be removed (−) and given again once.
- The first install backs up the official app to `build/official-<version>.zip` and its database to `build/official-<version>-openbot.db` (sqlite `.backup`). Upstream `main` migrates the database forward, and an older release refuses a newer database. Rollback: quit OpenBot, `rm -rf /Applications/OpenBot.app && ditto -x -k build/official-0.59.0.zip /Applications`, copy the `.db` back over `~/Library/Application Support/OpenBot/openbot.db` (and delete `openbot.db-wal` / `-shm`).
- For ~10–20 s after a start the composer says "Complete agent CLI setup to start": upstream marks the runtime ready only when every provider check ends (Hermes and OpenCode take 5–7 s). It is not a fork problem; wait, then the box says "Message <agent>".
