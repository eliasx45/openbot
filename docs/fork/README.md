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
  "-c.mac.identity=Developer ID Application: mohamed elias hamadouche (GQQBT37P3D)" \
  -c.mac.entitlements=scripts/fork/entitlements.mac.plist \
  -c.mac.extendInfo.ElectronTeamID=GQQBT37P3D
```

- Needs node >= 24 (`/opt/homebrew/bin` first on PATH; an nvm node 20 breaks the build) and bun.
- Nothing native compiles: the voice runtime, remote desktop runtime and Cua driver are pinned downloads. The Cua driver keeps Cua AI's own signature (`signIgnore` upstream).
- `scripts/fork/entitlements.mac.plist` is upstream's `build/entitlements.mac.plist` without `associated-domains` and the official `team-identifier`: those need the official team's provisioning profile, and without it macOS refuses to start the app. So `openbot.run` universal links don't open the fork.
- Electron comes from `@electron/get`'s cache (`~/Library/Caches/electron`), filled by `bun install`. If electron-builder's download ever stalls, put `electron-v<version>-darwin-arm64.zip` (checked against `SHASUMS256.txt`) in `build/electron-dist/` and add `-c.electronDist=build/electron-dist`.

## The Dock launcher

Click **OpenBot Launcher** in the Dock (`scripts/fork/app.sh`, installed by `scripts/fork/install-dock-app.sh` to `~/Applications/OpenBot Launcher.app`, pinned once).

- `main` unchanged since the last install (`build/fork-launcher/built-commit`): opens OpenBot at once.
- `main` changed: a small window builds it (Stop, closing the window or ⌘Q stop the whole build), moves the new bundle to `/Applications/OpenBot.app` and opens it. One build at a time (a `mkdir` lock).
- OpenBot running: never quit or replaced. `scripts/fork/app.sh --build` builds while it runs and keeps the result as the next install (`build/fork-launcher/OpenBot.app`); the next click with OpenBot quit installs it without building again.
- Commits that touch only `src/` / `packages/` are patched: an APFS clone of the installed app gets the new `app.asar`, `app.asar.unpacked` and `Info.plist` (the asar hash), `resources/` changes are synced in, then the bundle is re-signed and checked with `codesign --verify --deep --strict`; any failure is a full build. Docs, tests, other apps (mobile, API) and the launcher itself build nothing.
- Log: `build/fork-launcher/build.log` (first line names the parts: `full`, `( js)`, `( res js)`, `none`).

## Data, signature, rollback

- Same bundle id (`app.openbot.desktop`) and name as the release, so the fork opens the same data: `~/Library/Application Support/OpenBot` (userData is `appData/OpenBot` for a packaged app) and the agents in `~/OpenBot`.
- Signed with Elias's Developer ID (team `GQQBT37P3D`), hardened runtime, not notarized. macOS grants follow the signature, so they survive rebuilds. Grants given to the official app (team `ZTRDTUL87R`) must be removed (−) and given again once.
- The first install backs up the official app to `build/official-<version>.zip` and its database to `build/official-<version>-openbot.db` (sqlite `.backup`). Upstream `main` migrates the database forward, and an older release refuses a newer database. Rollback: quit OpenBot, `rm -rf /Applications/OpenBot.app && ditto -x -k build/official-0.59.0.zip /Applications`, copy the `.db` back over `~/Library/Application Support/OpenBot/openbot.db` (and delete `openbot.db-wal` / `-shm`).
