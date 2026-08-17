import Cocoa
import SwiftUI
import WebKit

// App.swift — menu bar item, onboarding window, and the window that shows the day.
//
// The app is the daemon. There is no launchd agent and no background helper: it samples in
// this process (which is where the Accessibility grant lives), runs the Node rollup on a
// timer, and serves the existing viewer into a WKWebView. One thing to install, one thing
// in the Accessibility list, one thing to quit.

@main
final class AppDelegate: NSObject, NSApplicationDelegate {
    /// NSApplication.delegate is a WEAK reference. A delegate held only by a local in
    /// main() is deallocated the moment main() returns, taking the status item, the
    /// sampler and every window with it — the app runs and does nothing at all.
    private static var retained: AppDelegate?

    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        retained = delegate
        app.delegate = delegate
        app.setActivationPolicy(.accessory)   // menu bar app; windows are shown on demand
        app.run()
    }

    private var statusItem: NSStatusItem!
    private let sampler = Sampler()
    private var rollupTimer: Timer?
    private var viewer: Process?
    private var viewerPort = 7787
    private var onboardingWindow: NSWindow?
    private var dayWindow: NSWindow?

    func applicationDidFinishLaunching(_ n: Notification) {
        buildMenuBar()
        if Store.isSetUp {
            beginRecording()
        } else {
            showOnboarding()
        }
    }

    func applicationWillTerminate(_ n: Notification) {
        sampler.stop()
        rollupTimer?.invalidate()
        viewer?.terminate()
    }

    // MARK: recording

    private func beginRecording() {
        Store.ensure()
        sampler.start()
        // Rolling up more often than a window is long just re-reads the same open slot.
        rollupTimer = Timer.scheduledTimer(withTimeInterval: 600, repeats: true) { _ in
            DispatchQueue.global(qos: .utility).async { Node.run(["rollup"]) }
        }
        rollupTimer?.tolerance = 60
        refreshMenu()
    }

    // MARK: menu bar

    private func buildMenuBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let img = NSImage(systemSymbolName: "sun.horizon.fill", accessibilityDescription: "My Day") {
            img.isTemplate = true
            statusItem.button?.image = img
        } else {
            // A variable-length item with neither image nor title is zero-width, which looks
            // exactly like the app failing to launch. Never leave it with nothing.
            statusItem.button?.title = "◔"
        }
        statusItem.menu = NSMenu()
        refreshMenu()
    }

    @objc private func refreshMenu() {
        guard let menu = statusItem?.menu else { return }
        menu.removeAllItems()

        let paused = (Store.config()["paused"] as? Bool) ?? false
        let counts = Store.sampleCount()
        let memories = Store.memoryCount()

        // Status is read from what was actually written, never from what should have been.
        let header = NSMenuItem(title: Store.isSetUp
            ? (paused ? "Paused" : "\(memories) notes today · \(counts.total) samples")
            : "Not set up", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)

        if Store.isSetUp && !paused && !Sampler.isTrusted {
            let warn = NSMenuItem(title: "Window titles off — click to allow", action: #selector(fixPermission), keyEquivalent: "")
            warn.target = self
            menu.addItem(warn)
        }

        menu.addItem(.separator())
        add(menu, "Open My Day", #selector(showDay))
        add(menu, paused ? "Resume recording" : "Pause recording", #selector(togglePause))
        menu.addItem(.separator())
        add(menu, "Settings…", #selector(showSettings))
        add(menu, "Reveal files in Finder", #selector(revealFiles))
        menu.addItem(.separator())
        add(menu, "Quit My Day", #selector(quit), key: "q")
    }

    private func add(_ menu: NSMenu, _ title: String, _ sel: Selector, key: String = "") {
        let i = NSMenuItem(title: title, action: sel, keyEquivalent: key)
        i.target = self
        menu.addItem(i)
    }

    // MARK: actions

    @objc private func togglePause() {
        let paused = (Store.config()["paused"] as? Bool) ?? false
        Store.write(["paused": !paused])
        refreshMenu()
    }

    @objc private func fixPermission() {
        Sampler.requestAccessibility()
        Sampler.openAccessibilityPane()
    }

    @objc private func revealFiles() {
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: Store.root.path)
    }

    @objc private func quit() { NSApp.terminate(nil) }

    @objc private func showSettings() {
        // The config file is the settings screen. It is documented, hand-editable, and the
        // CLI and app both read it, so a second editor would be a third source of truth.
        NSWorkspace.shared.open(Store.configURL)
    }

    // MARK: windows

    private func showOnboarding() {
        let model = OnboardingModel()
        let view = OnboardingView(model: model) { [weak self] in
            self?.onboardingWindow?.close()
            self?.onboardingWindow = nil
            self?.beginRecording()
            self?.showDay()
        }
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 480),
                         styleMask: [.titled, .closable],
                         backing: .buffered, defer: false)
        // A plain titled window. .fullSizeContentView with a transparent titlebar left the
        // hosting view with no opaque backing, so the desktop showed straight through.
        w.title = "My Day"
        w.isOpaque = true
        w.backgroundColor = .windowBackgroundColor
        w.center()
        // The hosting view needs its own backing layer painted. Setting the window's
        // backgroundColor alone leaves the content area clear, so whatever is behind the
        // app shows through the body of the window.
        let host = NSHostingView(rootView: view)
        host.wantsLayer = true
        host.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        w.contentView = host
        w.isReleasedWhenClosed = false
        onboardingWindow = w
        NSApp.activate(ignoringOtherApps: true)
        w.makeKeyAndOrderFront(nil)
    }

    @objc private func showDay() {
        if let w = dayWindow { NSApp.activate(ignoringOtherApps: true); w.makeKeyAndOrderFront(nil); return }

        guard Node.binary != nil, Node.cli != nil else { return showNodeMissing() }
        if viewer == nil || !(viewer!.isRunning) {
            viewerPort = Int.random(in: 7800...7899)
            viewer = Node.startViewer(port: viewerPort)
        }

        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 940, height: 700))
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 940, height: 700),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable],
                         backing: .buffered, defer: false)
        w.title = "My Day"
        w.center()
        w.contentView = web
        w.isReleasedWhenClosed = false
        dayWindow = w
        NSApp.activate(ignoringOtherApps: true)
        w.makeKeyAndOrderFront(nil)

        // The viewer needs a moment to bind before the first request.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            guard let self, let url = URL(string: "http://localhost:\(self.viewerPort)") else { return }
            web.load(URLRequest(url: url))
        }
    }

    private func showNodeMissing() {
        let a = NSAlert()
        a.messageText = "Node.js is required to read your notes"
        a.informativeText = "My Day records without it, but building and browsing your notes needs Node 18 or later.\n\nInstall it from nodejs.org, then reopen this window."
        a.addButton(withTitle: "Open nodejs.org")
        a.addButton(withTitle: "Later")
        NSApp.activate(ignoringOtherApps: true)
        if a.runModal() == .alertFirstButtonReturn {
            NSWorkspace.shared.open(URL(string: "https://nodejs.org")!)
        }
    }
}
