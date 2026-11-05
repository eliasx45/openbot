// Fork (docs/fork/FEATURES.md entry 36): builds the "From iPhone" helper app (native/macos/iphone-photo)
// into .openbot-build/iphone-photo/, which electron-builder copies into the app's Resources on macOS.
// It skips the build when the app is newer than its source. On other systems it does nothing.
//
//   bun scripts/prepare-iphone-photo.ts

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const source = join(root, "native/macos/iphone-photo/main.swift");
const app = join(root, ".openbot-build/iphone-photo/OpenBot iPhone Photo.app");
const binary = join(app, "Contents/MacOS/OpenBotIphonePhoto");

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>run.openbot.iphone-photo</string>
  <key>CFBundleName</key><string>OpenBot iPhone Photo</string>
  <key>CFBundleExecutable</key><string>OpenBotIphonePhoto</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`;

if (process.platform !== "darwin") process.exit(0);
if (existsSync(binary) && statSync(binary).mtimeMs > statSync(source).mtimeMs) process.exit(0);
rmSync(app, { recursive: true, force: true });
mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
writeFileSync(join(app, "Contents/Info.plist"), INFO_PLIST);
const built = spawnSync(
  "swiftc",
  ["-O", "-target", `${process.arch === "x64" ? "x86_64" : "arm64"}-apple-macos13.0`, "-o", binary, source],
  { stdio: "inherit" },
);
if (built.status !== 0) {
  rmSync(app, { recursive: true, force: true });
  process.exit(built.status ?? 1);
}
