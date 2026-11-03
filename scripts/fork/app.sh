#!/bin/sh
# Opens OpenBot (/Applications/OpenBot.app), building and installing it first only when local main
# has a new commit since the last install (fork-only; same shape as Codync's scripts/fork/app.sh).
# The build steps are upstream's `bun run package` (docs/fork/README.md), signed with Elias's
# Developer ID, for this Mac's architecture only. It builds the working tree, so uncommitted work
# is included, but only a new commit on main triggers a rebuild. Commits that touch only the app's
# JavaScript (src/, packages/) or its plain resources are swapped into a copy of the installed app;
# docs-only commits build nothing; anything else is a full build. Only one build runs at a time
# (a lock). A running OpenBot is never quit or replaced: the build waits as the next install, and
# the next click (with OpenBot quit) installs it without building again.
#
# Usage: scripts/fork/app.sh [--status | --build]
#   --status   print `running`, `stale` or `ready` and exit
#   --build    build main now and keep it as the next install (even while OpenBot runs); no install
# Exit status 130 when the build was stopped (SIGTERM / SIGINT / SIGHUP), 1 when it failed.
set -u
# Started from the Dock, PATH lacks Homebrew (bun, node 26: the build needs node >= 24, and an
# nvm node first on PATH would be 20).
PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.bun/bin:$PATH"
export PATH

root=$(cd "$(dirname "$0")/../.." && pwd)
app="/Applications/OpenBot.app"
state="$root/build/fork-launcher"
stamp="$state/built-commit"
lock="$state/build.lock"
log="$state/build.log"
# The next install: a finished build of $staged_commit, waiting for OpenBot to be quit.
staged="$state/OpenBot.app"
staged_commit="$state/staged-commit"
mkdir -p "$state"

# The Electron main process only (its helpers and agents run from the bundle too).
running() { pgrep -f "^$app/Contents/MacOS/OpenBot( |\$)" >/dev/null 2>&1; }
head_commit() { git -C "$root" rev-parse main 2>/dev/null; }
stale() {
    [ -d "$app" ] && [ -f "$stamp" ] || return 0
    [ "$(cat "$stamp")" != "$(head_commit)" ]
}
# A finished build of main's current commit is waiting.
staged_ready() {
    [ -d "$staged" ] && [ -f "$staged_commit" ] && [ "$(cat "$staged_commit")" = "$(head_commit)" ]
}

mode=open
case "${1:-}" in
--status)
    if running; then echo running; elif stale; then echo stale; else echo ready; fi
    exit 0
    ;;
--build) mode=build ;;
esac

build_pid=""
stop() {
    # Stop the whole build (bun, electron-builder, every codesign it started), then free the lock.
    if [ -n "$build_pid" ]; then
        kill -TERM -"$build_pid" 2>/dev/null || kill -TERM "$build_pid" 2>/dev/null
        wait "$build_pid" 2>/dev/null
    fi
    [ -f "$lock/pid" ] && [ "$(cat "$lock/pid" 2>/dev/null)" = "$$" ] && rm -rf "$lock"
    echo "build stopped" >>"$log"
    exit 130
}
trap stop TERM INT HUP

# Signed with Elias's Developer ID (not notarized: it never leaves this Mac). A stable signature
# keeps macOS privacy grants (Screen Recording, Accessibility, Automation) across rebuilds; an
# ad-hoc one is a new app to macOS every build. OPENBOT_SIGN_IDENTITY overrides. codesign gets the
# full name: an Apple Distribution certificate has the same short name.
# electron-builder wants the name without the type (it picks the Developer ID certificate itself).
identity_name=${OPENBOT_SIGN_IDENTITY:-mohamed elias hamadouche (GQQBT37P3D)}
identity="Developer ID Application: $identity_name"
team=GQQBT37P3D
entitlements="$root/scripts/fork/entitlements.mac.plist"
# Same flags for the signed full build and the unsigned JS build, so both make the same Info.plist.
# No secure timestamp: it asks Apple's server once per file and only matters for notarizing.
# The fork's entitlements: upstream's need the official team's provisioning profile.
builder_flags="--dir --mac --arm64 --publish never -c.mac.notarize=false -c.mac.timestamp=none -c.mac.entitlements=$entitlements -c.mac.extendInfo.ElectronTeamID=$team"

# What the commits since the last install change: `full`, `none` (docs, other apps, tests, this
# launcher), or the parts a patch swaps in: js (app.asar), res (plain files in Resources).
# Checked against what is compiled where: src/ reads resources/agent-import and
# resources/plugin-catalog/catalog.json, scripts/agent-runtime-lock and native-runtime.lock.json.
changes() {
    old=$(cat "$stamp" 2>/dev/null) && [ -d "$app" ] || { echo full; return; }
    git -C "$root" diff --name-only "$old" "$(head_commit)" >"$state/changed" 2>/dev/null || { echo full; return; }
    parts=""
    while IFS= read -r f; do
        case "$f" in
        # Dependencies, pinned runtimes, the fork's signing: everything again.
        package.json | */package.json | bun.lock | bunfig.toml | patches/* | native-runtime.lock.json | \
            scripts/fork/entitlements.mac.plist | electron-builder.yml) echo full; return ;;
        # Not bundled.
        *.test.ts | *.test.tsx | *.stories.tsx | */__snapshots__/*) ;;
        src/* | packages/* | electron.vite.config.ts | tsconfig*.json | scripts/agent-runtime-lock* | LICENSE | NOTICE) parts="$parts js" ;;
        resources/*) parts="$parts res js" ;;
        docs/* | plans/* | changelog.d/* | apps/* | remote/* | docker/* | nix/* | marketplace/* | .github/* | \
            .githooks/* | tools/* | scripts/fork/* | scripts/*-e2e.ts | scripts/*-smoke.ts | biome.json | knip.config.ts | flake.* | .gitignore) ;;
        *.md) ;;
        *) echo full; return ;;
        esac
    done <"$state/changed"
    echo "${parts:-none}"
}

# `bun install` only when the dependencies changed since the last one (it takes ~2 min).
install_deps() {
    sum=$(cat bun.lock package.json ./*/*/package.json patches/* 2>/dev/null | shasum | cut -c1-40)
    if [ -d node_modules ] && [ "$(cat "$state/deps-hash" 2>/dev/null)" = "$sum" ]; then return 0; fi
    bun install --frozen-lockfile
    echo "$sum" >"$state/deps-hash"
}

# Upstream's `bun run package`, signed. The runtimes are pinned downloads (nothing compiles) and
# each step skips what is already installed.
steps() {
    set -e
    cd "$root"
    install_deps
    bun run voice:prepare-runtime
    bun run prepare:remote-desktop-runtime
    bun run verify:remote-desktop-runtime
    bun run prepare:cua-driver
    bun run build
    rm -rf dist/mac-arm64
    # shellcheck disable=SC2086 # word-split flags
    bunx electron-builder $builder_flags "-c.mac.identity=$identity_name"
    rm -rf "$staged"
    mv dist/mac-arm64/OpenBot.app "$staged"
    codesign --verify --deep --strict "$staged"
}

sign() {
    codesign --force --sign "$identity" --timestamp=none --options runtime --entitlements "$entitlements" "$1"
}

# Builds only the changed parts ($1) and swaps them into an instant APFS copy of the installed app,
# then seals the bundle again; the frameworks, helpers and the Cua driver keep their signatures.
patch() {
    set -e
    cd "$root"
    rm -rf "$staged"
    cp -Rc "$app" "$staged"
    res="$staged/Contents/Resources"
    case " $1 " in *" res "*)
        for d in managed-skills plugin-catalog agent-import cli agent-runtime; do
            rsync -a --delete "resources/$d/" "$res/$d/"
        done
        ;;
    esac
    case " $1 " in *" js "*)
        install_deps
        bun run build
        rm -rf dist/mac-arm64
        # Unsigned, only for its app.asar (out/ and the production node_modules), the unpacked
        # hosts, and the Info.plist that carries app.asar's hash (ElectronAsarIntegrity).
        # shellcheck disable=SC2086 # word-split flags
        bunx electron-builder $builder_flags -c.mac.identity=null
        built="dist/mac-arm64/OpenBot.app/Contents"
        cp "$built/Resources/app.asar" "$res/app.asar"
        rsync -a --delete "$built/Resources/app.asar.unpacked/" "$res/app.asar.unpacked/"
        cp "$built/Info.plist" "$staged/Contents/Info.plist"
        rm -rf dist/mac-arm64
        # Native addons in the unpacked folder (koffi) came unsigned.
        find "$res/app.asar.unpacked" -type f \( -name '*.node' -o -name '*.dylib' \) | while IFS= read -r f; do
            codesign --force --sign "$identity" --timestamp=none --options runtime "$f"
        done
        ;;
    esac
    sign "$staged"
    codesign --verify --deep --strict "$staged"
}

# Runs one build function in its own process group, so stopping it stops every child too.
run() {
    set -m
    ("$@") >>"$log" 2>&1 &
    build_pid=$!
    set +m
    wait "$build_pid"
    status=$?
    build_pid=""
    return "$status"
}

take_lock() {
    # One build at a time: mkdir is atomic. A lock left by a process that's gone is cleared.
    while ! mkdir "$lock" 2>/dev/null; do
        owner=$(cat "$lock/pid" 2>/dev/null || echo "")
        if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
            sleep 2
        else
            rm -rf "$lock"
        fi
    done
    echo "$$" >"$lock/pid"
}

# Builds main into $staged (the next install). Returns 0 when nothing needs installing either.
build() {
    # Read before the build, so a commit landing while it runs makes the next launch build again.
    commit=$(head_commit)
    parts=$(changes)
    echo "building OpenBot main $commit ($parts) $(date)" >"$log"
    rm -f "$staged_commit"
    if [ "$parts" = none ]; then
        echo "nothing the app is built from changed" >>"$log"
        [ -n "$commit" ] && echo "$commit" >"$stamp"
        rm -rf "$staged"
        return 0
    fi
    started=$(date +%s)
    # Called on their own, not in `&&`/`||`: there the shell ignores the build's `set -e`.
    status=1
    if [ "$parts" != full ]; then
        run patch "$parts"
        status=$?
        # A failed patch never installs: build everything instead.
        [ "$status" -eq 0 ] || echo "patch failed: full build" >>"$log"
    fi
    if [ "$status" -ne 0 ]; then
        run steps
        status=$?
    fi
    if [ "$status" -eq 0 ] && [ ! -d "$staged" ]; then
        echo "build finished but $staged is missing" >>"$log"
        status=1
    fi
    if [ "$status" -eq 0 ]; then
        echo "$commit" >"$staged_commit"
        echo "built in $(($(date +%s) - started)) s" >>"$log"
    fi
    return "$status"
}

# The first install replaces the official release: keep it and its database for a rollback.
backup_official() {
    team_of=$(codesign -dv "$app" 2>&1 | sed -n 's/^TeamIdentifier=//p')
    [ -d "$app" ] && [ "$team_of" != "$team" ] || return 0
    version=$(defaults read "$app/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo unknown)
    zip="$root/build/official-$version.zip"
    [ -f "$zip" ] || ditto -c -k --keepParent "$app" "$zip"
    # Upstream main migrates the database forward; the old release refuses a newer one.
    db="$HOME/Library/Application Support/OpenBot/openbot.db"
    copy="$root/build/official-$version-openbot.db"
    [ -f "$copy" ] || [ ! -f "$db" ] || sqlite3 "$db" ".backup '$copy'"
}

# Moves the staged build in. Moved, not copied: only one OpenBot build exists.
install_staged() {
    if running; then
        echo "OpenBot was opened during the build: quit it and click again to install" >>"$log"
        return 1
    fi
    backup_official >>"$log" 2>&1 || { echo "backup of the official app failed: not installed" >>"$log"; return 1; }
    old="$state/replaced.app"
    rm -rf "$old"
    if [ -d "$app" ] && ! mv "$app" "$old"; then
        echo "can't move $app (allow OpenBot Launcher in System Settings > Privacy & Security > App Management)" >>"$log"
        return 1
    fi
    if mv "$staged" "$app"; then
        cat "$staged_commit" >"$stamp"
        rm -f "$staged_commit"
        rm -rf "$old"
        echo "installed $app" >>"$log"
    else
        [ -d "$old" ] && mv "$old" "$app"
        echo "install failed: $staged is still there" >>"$log"
        return 1
    fi
}

if [ "$mode" = build ]; then
    take_lock
    if staged_ready || ! stale; then
        status=0
    else
        build
        status=$?
    fi
    rm -rf "$lock"
    exit "$status"
fi

if running; then
    # Never quit or replace a running app (its agents live in it): bring it forward.
    open "$app"
    echo "OpenBot is already running" >&2
    exit 0
fi

if stale; then
    take_lock
    status=0
    if ! staged_ready; then
        build
        status=$?
    fi
    if [ "$status" -eq 0 ] && staged_ready; then
        install_staged
        status=$?
    fi
    rm -rf "$lock"
    [ "$status" -eq 0 ] || { echo "build failed, see $log" >&2; exit 1; }
fi
open "$app"
exit 0
