// OpenBot (fork) Dock launcher. scripts/fork/install-dock-app.sh compiles it into
// ~/Applications/OpenBot Launcher.app. Click: opens /Applications/OpenBot.app, building
// and installing it first only when local main has new commits (scripts/fork/app.sh). While it
// builds, a small window shows progress; Stop, closing the window, Cmd-Q or Quit from the Dock stop
// the build. A running OpenBot is never quit or replaced.
//
// The launcher doesn't stay running: OpenBot is a real app bundle with its own privacy
// permissions, so app.sh `open`s it and the launcher quits. A build made while OpenBot ran
// (app.sh --build) is installed by the next click without building again.

import AppKit

let root = Bundle.main.object(forInfoDictionaryKey: "OpenBotRoot") as? String ?? ""
let script = root + "/scripts/fork/app.sh"
let log = root + "/build/fork-launcher/build.log"

/// Runs app.sh with `args` and returns its trimmed output (empty on failure).
func run(_ args: [String]) -> String {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/sh")
    p.arguments = [script] + args
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    guard (try? p.run()) != nil else { return "" }
    p.waitUntilExit()
    let data = out.fileHandleForReading.readDataToEndOfFile()
    return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
}

/// The last meaningful line of the build log (bun, electron-vite, electron-builder, or an error).
func lastLogLine() -> String {
    guard let text = try? String(contentsOfFile: log, encoding: .utf8) else { return "" }
    for line in text.split(separator: "\n").reversed() {
        let t = line.trimmingCharacters(in: .whitespaces)
        // Only a dyld failure's notes are skipped: electron-builder's progress lines are indented
        // (`  • signing …`), so indented lines stay.
        if t.isEmpty || t.hasPrefix("Reason:") || t.hasPrefix("Referenced from:") || t.hasPrefix("dyld[") { continue }
        return String(t.prefix(80))
    }
    return ""
}

final class Launcher: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow?
    var detail = NSTextField(labelWithString: "Only what changed since the last build.")
    var build: Process?
    var timer: Timer?
    var stopping = false

    func applicationDidFinishLaunching(_ note: Notification) {
        if run(["--status"]) == "stale" {
            startBuild()
        } else {
            // running or ready: app.sh opens (or brings forward) OpenBot.
            _ = run([])
            NSApp.terminate(nil)
        }
    }

    func startBuild() {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 130), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        w.title = "OpenBot"
        w.delegate = self
        let title = NSTextField(labelWithString: "Building OpenBot from main…")
        title.font = .boldSystemFont(ofSize: 14)
        detail.textColor = .secondaryLabelColor
        detail.lineBreakMode = .byTruncatingTail
        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.startAnimation(nil)
        let stop = NSButton(title: "Stop", target: self, action: #selector(stopPressed))
        stop.keyEquivalent = "\u{1b}"
        let top = NSStackView(views: [spinner, title])
        let stack = NSStackView(views: [top, detail, stop])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 18, left: 20, bottom: 16, right: 20)
        stack.translatesAutoresizingMaskIntoConstraints = false
        w.contentView?.addSubview(stack)
        if let c = w.contentView {
            NSLayoutConstraint.activate([
                stack.leadingAnchor.constraint(equalTo: c.leadingAnchor),
                stack.trailingAnchor.constraint(equalTo: c.trailingAnchor),
                stack.topAnchor.constraint(equalTo: c.topAnchor),
                detail.widthAnchor.constraint(equalToConstant: 380),
            ])
        }
        w.center()
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        window = w

        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        // Builds, installs and opens OpenBot.
        p.arguments = [script]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        p.terminationHandler = { [weak self] proc in
            let status = proc.terminationStatus
            DispatchQueue.main.async { self?.buildEnded(status: status) }
        }
        do {
            try p.run()
        } catch {
            fail("Couldn't start the build: \(error.localizedDescription)")
            return
        }
        build = p
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            let line = lastLogLine()
            if !line.isEmpty { self?.detail.stringValue = line }
        }
    }

    func buildEnded(status: Int32) {
        timer?.invalidate()
        build = nil
        if stopping || status == 0 {
            NSApp.terminate(nil)
            return
        }
        fail("The OpenBot build failed.")
    }

    func fail(_ message: String) {
        window?.orderOut(nil)
        let alert = NSAlert()
        alert.messageText = message
        alert.informativeText = "The build log has the details."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Show Log")
        if alert.runModal() == .alertSecondButtonReturn {
            NSWorkspace.shared.open(URL(fileURLWithPath: log))
        }
        NSApp.terminate(nil)
    }

    /// Stop the build (app.sh stops it and everything it started), then quit.
    func stopBuild() {
        guard let p = build, p.isRunning else { return }
        stopping = true
        detail.stringValue = "Stopping…"
        p.terminate()
    }

    @objc func stopPressed() {
        if build?.isRunning == true { stopBuild() } else { NSApp.terminate(nil) }
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if build?.isRunning == true {
            stopBuild()
            return false
        }
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if build?.isRunning == true {
            // Cmd-Q or Quit from the Dock: stop the build first; buildEnded() quits.
            stopBuild()
            return .terminateCancel
        }
        return .terminateNow
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let delegate = Launcher()
app.delegate = delegate
app.setActivationPolicy(.regular)
// A menu with Quit, so Cmd-Q stops the build too.
let menu = NSMenu()
let appItem = NSMenuItem()
appItem.submenu = NSMenu()
appItem.submenu?.addItem(withTitle: "Quit OpenBot Launcher", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
menu.addItem(appItem)
app.mainMenu = menu
app.run()
