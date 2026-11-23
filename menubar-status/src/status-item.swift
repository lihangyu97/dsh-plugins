// dsh-menubar — a macOS menu bar indicator for DeepSeek Harness sessions.
//
// Why this exists as a separate process: DSH plugins run inside the Host Node
// child process, which has no AppKit access, so the menu bar item itself must be
// native. The Host plugin owns this process, feeds it state on stdin, and kills
// it on unload; stdin EOF is the same signal, so a crashed or exited Host can
// never leave a stale number behind in the menu bar.
//
// Wire format, one JSON object per line on stdin:
//   {"title":"1/3","tooltip":"运行中 1 个 · 已完成/待答复 3 个","header":"…"}
// A line that is not JSON is used verbatim as the button title, which keeps the
// helper usable by hand while debugging.
//
// Build: ./build.sh   (swiftc, no signing, no bundle)

import AppKit
import Foundation

// MARK: - Arguments

struct Arguments {
    var iconPath: String?
    var bundleID = "com.deepseek.dsh"
    var fallbackTitle = "DeepSeek Harness"

    static func parse(_ argv: [String]) -> Arguments {
        var arguments = Arguments()
        var index = 1
        while index < argv.count {
            let flag = argv[index]
            let value = index + 1 < argv.count ? argv[index + 1] : nil
            switch flag {
            case "--icon": arguments.iconPath = value; index += 2
            case "--app": arguments.bundleID = value ?? arguments.bundleID; index += 2
            case "--title": arguments.fallbackTitle = value ?? arguments.fallbackTitle; index += 2
            default: index += 1
            }
        }
        return arguments
    }
}

let arguments = Arguments.parse(CommandLine.arguments)

// MARK: - Single instance

/// Exactly one icon may exist: a plugin reload can leave the previous helper
/// orphaned when a disposer is skipped, and a second launch must win rather than
/// stack a second whale in the menu bar. The lock file is advisory and always
/// points at the newest process, so a stale pid is simply overwritten.
enum SingleInstance {
    static let path = (NSTemporaryDirectory() as NSString).appendingPathComponent("dsh-menubar.lock")

    static func claim() {
        if let raw = try? String(contentsOfFile: path, encoding: .utf8),
           let pid = pid_t(raw.trimmingCharacters(in: .whitespacesAndNewlines)),
           pid > 0, pid != getpid(), kill(pid, 0) == 0 {
            kill(pid, SIGTERM)
            usleep(250_000)
        }
        try? "\(getpid())\n".write(toFile: path, atomically: true, encoding: .utf8)
    }
}

// MARK: - Status item controller

final class MenuBarController: NSObject, NSApplicationDelegate {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    /// Recreated per menu rebuild: an NSMenuItem cannot be moved between menus.
    private var stateItem = NSMenuItem(title: "等待会话状态…", action: nil, keyEquivalent: "")
    private var headerText = "等待会话状态…"
    /// One row per Session that wants attention, rendered as menu entries.
    private var detailItems: [String] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        SingleInstance.claim()
        let button = item.button!
        button.image = loadIcon()
        button.imagePosition = .imageLeading
        button.imageScaling = .scaleProportionallyDown
        // Match the menu bar's own text (the clock, the Wi-Fi label): the system
        // font at menu bar size, not a monospaced digit face.
        button.font = NSFont.menuBarFont(ofSize: 0)
        button.title = ""
        button.target = self
        button.action = #selector(handleClick)
        button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        button.toolTip = arguments.fallbackTitle
        item.isVisible = true

        rebuildMenu()

        startReadingState()
    }

    /// The glyph is a template image: AppKit draws it black or white to match
    /// the menu bar, so only its alpha channel matters.
    private func loadIcon() -> NSImage? {
        guard let path = arguments.iconPath else { return nil }
        let retina = path.replacingOccurrences(of: ".png", with: "@2x.png")
        let source = FileManager.default.fileExists(atPath: retina) ? retina : path
        guard let image = NSImage(contentsOfFile: source) else { return nil }
        image.isTemplate = true
        image.size = NSSize(width: 17, height: 17)
        return image
    }

    private func startReadingState() {
        let queue = DispatchQueue(label: "dsh-menubar.stdin", qos: .utility)
        queue.async {
            while let line = readLine(strippingNewline: true) {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if trimmed.isEmpty { continue }
                DispatchQueue.main.async { self.apply(stateLine: trimmed) }
            }
            // The Host is gone (or closed our stdin): never leave a stale icon.
            DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
        }
    }

    private func apply(stateLine line: String) {
        var title = line
        if line.hasPrefix("{"),
           let data = line.data(using: .utf8),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            title = object["title"] as? String ?? ""
            if let tooltip = object["tooltip"] as? String, !tooltip.isEmpty {
                item.button?.toolTip = tooltip
            }
            if let header = object["header"] as? String, !header.isEmpty {
                headerText = header
            }
            // Hiding the item keeps the menu bar clean before the first Session,
            // without tearing down the helper and losing the state it holds.
            item.isVisible = !(object["hidden"] as? Bool ?? false)

            // Which Sessions those numbers refer to; the menu is rebuilt only when
            // the list actually changed, so a quiet counter never rebuilds it.
            if let rows = object["items"] as? [String], rows != detailItems {
                detailItems = rows
                rebuildMenu()
            }
        }
        item.button?.title = title
        if stateItem.title != headerText {
            stateItem.title = headerText
        }
    }

    // MARK: Menu

    private func rebuildMenu() {
        let menu = NSMenu()
        stateItem = NSMenuItem(title: headerText, action: nil, keyEquivalent: "")
        stateItem.isEnabled = false
        menu.addItem(stateItem)

        if !detailItems.isEmpty {
            menu.addItem(.separator())
            for label in detailItems {
                let row = NSMenuItem(title: label, action: #selector(activateApplication), keyEquivalent: "")
                row.target = self
                menu.addItem(row)
            }
        }

        menu.addItem(.separator())

        let show = NSMenuItem(title: "显示 DeepSeek Harness", action: #selector(activateApplication), keyEquivalent: "")
        show.target = self
        menu.addItem(show)

        let quit = NSMenuItem(title: "退出菜单栏图标", action: #selector(quit), keyEquivalent: "")
        quit.target = self
        menu.addItem(quit)

        item.menu = menu
    }

    /// Left click activates the app; right click opens the menu, which is the
    /// convention every menu bar utility follows. The menu is attached only for
    /// the duration of a right click, otherwise AppKit would swallow the left
    /// click and always show the menu.
    @objc private func handleClick() {
        let isRightClick = NSApp.currentEvent?.type == .rightMouseUp
        guard isRightClick else {
            activateApplication()
            return
        }
        item.menu = item.menu ?? NSMenu()
        item.button?.performClick(nil)
        item.menu = nil
    }

    @objc private func activateApplication() {
        if let running = NSRunningApplication.runningApplications(withBundleIdentifier: arguments.bundleID).first {
            running.activate(options: [.activateAllWindows])
            return
        }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: arguments.bundleID) else {
            NSSound.beep()
            return
        }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.openApplication(at: url, configuration: configuration, completionHandler: nil)
    }

    @objc private func quit() {
        NSApplication.shared.terminate(nil)
    }
}

// MARK: - Entry point

let application = NSApplication.shared
let controller = MenuBarController()
application.delegate = controller
application.setActivationPolicy(.accessory)
application.run()
