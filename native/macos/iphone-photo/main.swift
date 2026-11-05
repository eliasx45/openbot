// Fork (docs/fork/FEATURES.md entry 36): "From iPhone" in the message box's + menu. OpenBot starts this
// helper; it opens macOS Continuity Camera's menu (Take Photo / Scan Documents / Add Sketch on a nearby
// iPhone) at the pointer and writes the photo as a JPEG to the path in its first argument. It prints one
// line of JSON and exits: {"outcome":"picked"|"dismissed"|"noDevice"|"timeout"|"failed"}.
//
// Why a helper: AppKit offers the iPhone only to a responder in the key window's responder chain that
// answers validRequestorForSendType:returnType: for an image type, and only when the menu is popped
// with popUpContextMenu:withEvent:forView: as an EMPTY menu (AppKit inserts the iPhone items itself).
// Electron's window cannot be that responder. Recipe proven in Ghostex
// (apps/desktop/native/macos/GpuiContinuityCamera.m, 26 Oct 2026).
//
//   OpenBotIphonePhoto <out.jpg> [--wait <seconds>] [--test-image <file>]
//
// `--test-image` converts that file and reports "picked" without any menu (end-to-end checks).

import AppKit

func report(_ outcome: String) -> Never {
  FileHandle.standardOutput.write(Data("{\"outcome\":\"\(outcome)\"}\n".utf8))
  exit(0)
}

func jpeg(_ image: NSImage) -> Data? {
  guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
  return NSBitmapImageRep(cgImage: cg).representation(using: .jpeg, properties: [.compressionFactor: 0.85])
}

func save(_ image: NSImage, to path: String) -> Bool {
  guard let data = jpeg(image), !data.isEmpty else { return false }
  return FileManager.default.createFile(atPath: path, contents: data)
}

let args = CommandLine.arguments
guard args.count >= 2 else { report("failed") }
let outPath = args[1]
func option(_ name: String) -> String? {
  guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
  return args[index + 1]
}
let wait = Double(option("--wait") ?? "") ?? 120

if let test = option("--test-image") {
  guard let image = NSImage(contentsOfFile: test) else { report("failed") }
  report(save(image, to: outPath) ? "picked" : "failed")
}

final class PhotoView: NSView, NSServicesMenuRequestor {
  var wanted = true
  override var acceptsFirstResponder: Bool { true }

  override func validRequestor(
    forSendType sendType: NSPasteboard.PasteboardType?, returnType: NSPasteboard.PasteboardType?
  ) -> Any? {
    if wanted, let type = returnType, NSImage.imageTypes.contains(type.rawValue) { return self }
    return super.validRequestor(forSendType: sendType, returnType: returnType)
  }

  func readSelection(from pasteboard: NSPasteboard) -> Bool {
    wanted = false
    guard let image = NSImage(pasteboard: pasteboard) else { return false }
    report(save(image, to: outPath) ? "picked" : "failed")
  }

  func writeSelection(to pasteboard: NSPasteboard, types: [NSPasteboard.PasteboardType]) -> Bool { false }
}

/// A borderless window can't become key by default. Continuity Camera enables its iPhone items only
/// for a requestor in the KEY window's responder chain, so this window must be allowed to be key.
final class KeyWindow: NSWindow {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { true }
}

final class Delegate: NSObject, NSApplicationDelegate {
  var window: NSWindow?

  func applicationDidFinishLaunching(_ notification: Notification) {
    // A 1×1 clear window at the pointer: the menu opens there, and its view is the requestor.
    let at = NSEvent.mouseLocation
    let window = KeyWindow(
      contentRect: NSRect(x: at.x, y: at.y - 1, width: 1, height: 1), styleMask: .borderless,
      backing: .buffered, defer: false)
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = false
    window.level = .popUpMenu
    let view = PhotoView(frame: NSRect(x: 0, y: 0, width: 1, height: 1))
    window.contentView = view
    self.window = window
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
    window.makeFirstResponder(view)
    // The menu tracks in a run loop of its own: open it on a later turn, not inside launch, and only
    // once this app is active and the window is key (macOS may give activation a moment).
    waitForKey(window: window, view: view, tries: 40)
  }

  func waitForKey(window: NSWindow, view: PhotoView, tries: Int) {
    if (NSApp.isActive && window.isKeyWindow) || tries == 0 {
      FileHandle.standardError.write(
        "iphone-photo: active=\(NSApp.isActive) key=\(window.isKeyWindow) firstResponder=\(window.firstResponder === view)\n"
          .data(using: .utf8)!)
      if window.firstResponder !== view { window.makeFirstResponder(view) }
      popMenu(window: window, view: view)
      return
    }
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.025) {
      self.waitForKey(window: window, view: view, tries: tries - 1)
    }
  }

  func popMenu(window: NSWindow, view: PhotoView) {
    var sent = false
    let observer = NotificationCenter.default.addObserver(
      forName: NSMenu.didSendActionNotification, object: nil, queue: nil
    ) { _ in sent = true }
    guard
      let event = NSEvent.mouseEvent(
        with: .rightMouseDown, location: NSPoint(x: 0, y: 0), modifierFlags: [],
        timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
        eventNumber: 0, clickCount: 1, pressure: 1)
    else { report("failed") }
    let opened = ProcessInfo.processInfo.systemUptime
    NSMenu.popUpContextMenu(NSMenu(title: ""), with: event, for: view)
    let shown = ProcessInfo.processInfo.systemUptime - opened
    NotificationCenter.default.removeObserver(observer)
    // An empty menu (no iPhone in reach) closes at once without showing.
    guard sent else { report(shown < 0.15 ? "noDevice" : "dismissed") }
    // The photo comes when it is taken on the iPhone, after the menu closed.
    DispatchQueue.main.asyncAfter(deadline: .now() + wait) { report("timeout") }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = Delegate()
app.delegate = delegate
app.run()
