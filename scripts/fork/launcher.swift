// OpenBot (fork) starter: the main executable of the OpenBot.app that scripts/fork/app.sh installs,
// so the Dock pins one app and shows one icon. app.sh renames Electron's binary to `OpenBot-app`
// (signed with the same Developer ID and identifier, so macOS privacy grants stay), puts this one
// in its place as `OpenBot`, and writes the repo path into Info.plist (`OpenBotRoot`). (Before: a
// separate OpenBot Launcher.app opened OpenBot.app, so the Dock showed both icons.)
//
// Launch: when local main has no new commit since the install, it becomes OpenBot in the same
// process (execv), so macOS sees one app. When main moved, a small window shows the build
// (`app.sh --update`); Stop, closing the window, Cmd-Q or Quit from the Dock stop
// it, and "Open Without Updating" opens the installed version. After the install OpenBot reopens
// itself. No build in the first 5 minutes after a restart (OpenBot is a login item).
// OPENBOT_SKIP_BUILD=1 skips the check (that relaunch, or when the repo isn't there).

import AppKit
import Darwin

let macos = (Bundle.main.executablePath.map { ($0 as NSString).deletingLastPathComponent }) ?? ""
let real = macos + "/OpenBot-app"
let root = Bundle.main.object(forInfoDictionaryKey: "OpenBotRoot") as? String ?? ""
let script = root + "/scripts/fork/app.sh"
let log = root + "/build/fork-launcher/build.log"
let bundlePath = Bundle.main.bundlePath

/// Becomes OpenBot in this process (same pid, same Dock icon). Only before AppKit starts.
func becomeApp() -> Never {
    var args = CommandLine.arguments
    args[0] = real
    let cargs = args.map { strdup($0) } + [nil]
    execv(real, cargs)
    // execv only returns on failure.
    fputs("OpenBot starter: couldn't start \(real): \(String(cString: strerror(errno)))\n", stderr)
    exit(1)
}

/// Seconds since the Mac started.
func uptime() -> Double {
    var boot = timeval()
    var size = MemoryLayout<timeval>.size
    guard sysctlbyname("kern.boottime", &boot, &size, nil, 0) == 0 else { return .infinity }
    return Date().timeIntervalSince1970 - Double(boot.tv_sec)
}

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

/// Opens OpenBot.app again once this process has quit (the new bundle, or the installed one).
func reopenAfterExit() {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/sh")
    p.arguments = ["-c", "while kill -0 \(getpid()) 2>/dev/null; do sleep 0.1; done; open --env OPENBOT_SKIP_BUILD=1 \"$0\"", bundlePath]
    p.standardOutput = FileHandle.nullDevice
    p.standardError = FileHandle.nullDevice
    try? p.run()
}

let skip = ProcessInfo.processInfo.environment["OPENBOT_SKIP_BUILD"] != nil
if skip || root.isEmpty || !FileManager.default.fileExists(atPath: script) || uptime() < 300 || run(["--stale"]) != "stale" {
    becomeApp()
}

final class Builder: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var window: NSWindow?
    var detail = NSTextField(labelWithString: "Only what changed since the last build.")
    var build: Process?
    var timer: Timer?
    /// What to do once the build process has ended after Stop: quit, or open the installed version.
    var afterStop: (() -> Void)?

    func applicationDidFinishLaunching(_ note: Notification) {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 130), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        w.title = "OpenBot"
        w.delegate = self
        let title = NSTextField(labelWithString: "Updating OpenBot from main…")
        title.font = .boldSystemFont(ofSize: 14)
        detail.textColor = .secondaryLabelColor
        detail.lineBreakMode = .byTruncatingTail
        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.controlSize = .small
        spinner.startAnimation(nil)
        let stop = NSButton(title: "Stop", target: self, action: #selector(stopPressed))
        stop.keyEquivalent = "\u{1b}"
        let skipButton = NSButton(title: "Open Without Updating", target: self, action: #selector(openInstalledPressed))
        let top = NSStackView(views: [spinner, title])
        let buttons = NSStackView(views: [stop, skipButton])
        let stack = NSStackView(views: [top, detail, buttons])
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
        // Builds main into the next install, then moves it into /Applications; doesn't open it.
        // OPENBOT_STARTER_PID: app.sh doesn't count this process as a running OpenBot.
        p.arguments = [script, "--update"]
        var env = ProcessInfo.processInfo.environment
        env["OPENBOT_STARTER_PID"] = String(getpid())
        p.environment = env
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
        if let then = afterStop {
            then()
            NSApp.terminate(nil)
            return
        }
        if status == 0 {
            reopenAfterExit()
            NSApp.terminate(nil)
            return
        }
        fail("The OpenBot build failed.")
    }

    func fail(_ message: String) {
        window?.orderOut(nil)
        let alert = NSAlert()
        alert.messageText = message
        alert.informativeText = "The installed version still works. The build log has the details."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Open Installed Version")
        alert.addButton(withTitle: "Show Log")
        alert.addButton(withTitle: "Quit")
        switch alert.runModal() {
        case .alertFirstButtonReturn: reopenAfterExit()
        case .alertSecondButtonReturn: NSWorkspace.shared.open(URL(fileURLWithPath: log))
        default: break
        }
        NSApp.terminate(nil)
    }

    /// Stop the build (app.sh stops it and everything it started); `then` runs once it has ended.
    func stopBuild(then: @escaping () -> Void) {
        guard let p = build, p.isRunning else {
            then()
            NSApp.terminate(nil)
            return
        }
        afterStop = then
        detail.stringValue = "Stopping…"
        p.terminate()
    }

    @objc func stopPressed() { stopBuild {} }

    @objc func openInstalledPressed() { stopBuild { reopenAfterExit() } }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if build?.isRunning == true {
            stopBuild {}
            return false
        }
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if build?.isRunning == true {
            // Cmd-Q or Quit from the Dock: stop the build first; buildEnded() quits.
            stopBuild {}
            return .terminateCancel
        }
        return .terminateNow
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let delegate = Builder()
app.delegate = delegate
app.setActivationPolicy(.regular)
// A menu with Quit, so Cmd-Q stops the build too.
let menu = NSMenu()
let appItem = NSMenuItem()
appItem.submenu = NSMenu()
appItem.submenu?.addItem(withTitle: "Quit OpenBot", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
menu.addItem(appItem)
app.mainMenu = menu
app.run()
