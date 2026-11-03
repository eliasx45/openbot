#!/bin/sh
# Installs (or updates) ~/Applications/OpenBot Launcher.app, the Dock launcher for
# scripts/fork/app.sh (source: scripts/fork/launcher.swift), and adds it to the Dock once. Re-run
# after changing the launcher. macOS only; needs the Xcode command line tools (swiftc).
set -eu

root=$(cd "$(dirname "$0")/../.." && pwd)
app="$HOME/Applications/OpenBot Launcher.app"

mkdir -p "$HOME/Applications"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
swiftc -O -o "$app/Contents/MacOS/OpenBotForkLauncher" "$root/scripts/fork/launcher.swift" -framework AppKit
icon="/Applications/OpenBot.app/Contents/Resources/icon.icns"
[ -f "$icon" ] && cp "$icon" "$app/Contents/Resources/AppIcon.icns"
cat >"$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>OpenBot Launcher</string>
    <key>CFBundleDisplayName</key><string>OpenBot Launcher</string>
    <key>CFBundleIdentifier</key><string>com.eliasx45.openbot-fork.launcher</string>
    <key>CFBundleExecutable</key><string>OpenBotForkLauncher</string>
    <key>CFBundleIconFile</key><string>AppIcon</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>OpenBotRoot</key><string>$root</string>
</dict>
</plist>
EOF
# Signed with the same Developer ID as the fork's OpenBot: macOS lets an app replace apps of its
# own team without the App Management grant, and the grant (needed once, to replace the official
# release) survives a reinstall of the launcher. Ad-hoc when the certificate is missing.
codesign --force --sign "Developer ID Application: mohamed elias hamadouche (GQQBT37P3D)" --timestamp=none "$app" >/dev/null 2>&1 ||
    codesign --force --sign - "$app" >/dev/null 2>&1 || true
touch "$app"

# Pin it to the Dock once.
if ! defaults read com.apple.dock persistent-apps 2>/dev/null | grep -q "OpenBot%20Launcher.app"; then
    url="file://$(printf '%s' "$app" | sed 's/ /%20/g')/"
    defaults write com.apple.dock persistent-apps -array-add \
        "<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>$url</string><key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>"
    killall Dock
fi
echo "installed $app"
