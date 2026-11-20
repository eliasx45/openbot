#!/bin/sh
# One Dock icon for the fork: the Dock pins /Applications/OpenBot.app itself, whose main executable
# is the update starter (scripts/fork/launcher.swift, wrapped in by scripts/fork/app.sh at every
# install). Once the installed app has the starter, this removes the old separate "OpenBot
# Launcher" pin (pinning OpenBot.app in its place when it isn't pinned yet) and moves
# ~/Applications/OpenBot Launcher.app to the Trash. Before that it changes nothing: the old
# launcher's next click installs a build with the starter, and app.sh then runs this script.
set -eu

app="/Applications/OpenBot.app"
old="$HOME/Applications/OpenBot Launcher.app"

if [ ! -f "$app/Contents/MacOS/OpenBot-app" ]; then
    echo "OpenBot.app has no starter yet: the next update from the launcher installs it"
    exit 0
fi

tmp=$(mktemp -t dock)
defaults export com.apple.dock "$tmp"
changed=$(/usr/bin/python3 - "$tmp" "$app" <<'EOF'
import plistlib, sys
path, app = sys.argv[1], sys.argv[2]
with open(path, "rb") as f:
    d = plistlib.load(f)
apps = d.get("persistent-apps", [])
url = "file://" + app.replace(" ", "%20") + "/"
tile = {"tile-data": {"file-data": {"_CFURLString": url, "_CFURLStringType": 15}, "file-label": "OpenBot",
                      "bundle-identifier": "app.openbot.desktop"}, "tile-type": "file-tile"}
def u(t):
    return t.get("tile-data", {}).get("file-data", {}).get("_CFURLString", "")
has_app = any(u(t) == url for t in apps)
out, changed = [], False
for t in apps:
    if "OpenBot%20Launcher.app" in u(t):
        changed = True
        if not has_app:
            out.append(tile)
            has_app = True
        continue
    out.append(t)
if not has_app:
    out.append(tile)
    changed = True
d["persistent-apps"] = out
with open(path, "wb") as f:
    plistlib.dump(d, f)
print("yes" if changed else "no")
EOF
)
if [ "$changed" = yes ]; then
    defaults import com.apple.dock "$tmp"
    killall Dock
fi
rm -f "$tmp"

if [ -d "$old" ]; then
    osascript -e "tell application \"Finder\" to delete POSIX file \"$old\"" >/dev/null
    echo "moved $old to the Trash"
fi
echo "Dock: $app"
