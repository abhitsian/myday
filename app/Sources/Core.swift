import Cocoa
import ApplicationServices

// Core.swift — storage, capture, and the bridge to the Node side.
//
// The app writes exactly the same files the CLI does (~/.myday/raw/*.jsonl,
// ~/.myday/config.json), so the two are interchangeable: install the app, use the CLI,
// point the MCP server at it, all against one store.
//
// Capture happens IN THIS PROCESS rather than in a helper binary. That is the whole reason
// the app exists. Accessibility is granted per-binary, so a separate helper meant asking
// people to find a file inside node_modules in a file picker, and meant the grant silently
// died on every package update. An app bundle can ask for the permission itself, keeps it
// across updates, and is a thing a person can recognise in the Accessibility list.

enum Store {
    static let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".myday")
    static var raw: URL { root.appendingPathComponent("raw") }
    static var memories: URL { root.appendingPathComponent("memories") }
    static var configURL: URL { root.appendingPathComponent("config.json") }

    static var isSetUp: Bool { FileManager.default.fileExists(atPath: configURL.path) }

    static func ensure() {
        for d in [root, raw, memories] {
            try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        }
        // Keep a plaintext record of the user's whole day out of the system search index.
        let marker = root.appendingPathComponent(".metadata_never_index")
        if !FileManager.default.fileExists(atPath: marker.path) {
            FileManager.default.createFile(atPath: marker.path, contents: Data())
        }
    }

    static func config() -> [String: Any] {
        guard let d = try? Data(contentsOf: configURL),
              let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return defaults }
        return defaults.merging(j) { _, new in new }
    }

    static func write(_ patch: [String: Any]) {
        ensure()
        var c = config()
        for (k, v) in patch { c[k] = v }
        if let d = try? JSONSerialization.data(withJSONObject: c, options: [.prettyPrinted, .sortedKeys]) {
            try? d.write(to: configURL)
        }
    }

    // Mirrors lib/store.js DEFAULTS. Local summarizer means a fresh install sends nothing
    // anywhere until the person chooses otherwise.
    static let defaults: [String: Any] = [
        "paused": false,
        "summarizer": "local",
        "model": "claude-haiku-4-5-20251001",
        "excludeApps": ["1Password", "Passwords", "Keychain Access", "Bitwarden", "LastPass", "Dashlane", "Authenticator", "Tor Browser"],
        "excludeSites": ["*password*", "*bank*", "accounts.google.com", "login.microsoftonline.com", "*.onlinebanking.*", "health.*", "*medical*"],
        "excludeTitlePatterns": [String](),
        "appMode": "exclude",
        "includeApps": [String](),
        "siteMode": "exclude",
        "includeSites": [String](),
        "captureTitles": true,
        "captureBrowsers": true,
        "browsers": ["Chrome", "Brave", "Edge", "Arc", "Vivaldi"],
        "rawRetentionDays": 14,
        "intervalSec": 15,
        "idleMaxSec": 120,
    ]

    static func todayKey(_ date: Date = Date()) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
    }

    // Local time with no zone suffix, matching the CLI. An ISO-8601 UTC stamp inside a
    // local-dated folder shifts every slot by the UTC offset, which is a bug this project
    // already shipped once.
    static func stamp(_ date: Date = Date()) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        return String(format: "%04d-%02d-%02dT%02d:%02d:%02d", c.year!, c.month!, c.day!, c.hour!, c.minute!, c.second!)
    }

    static func appendSample(app: String, title: String, idle: Int) {
        ensure()
        let obj: [String: Any] = ["ts": stamp(), "app": app, "title": title, "idle": idle]
        guard var d = try? JSONSerialization.data(withJSONObject: obj) else { return }
        d.append(0x0A)
        let url = raw.appendingPathComponent("\(todayKey()).jsonl")
        if let h = try? FileHandle(forWritingTo: url) {
            h.seekToEndOfFile(); h.write(d); try? h.close()
        } else {
            try? d.write(to: url)
        }
    }

    static func sampleCount(_ date: String = todayKey()) -> (total: Int, titled: Int) {
        guard let s = try? String(contentsOf: raw.appendingPathComponent("\(date).jsonl"), encoding: .utf8) else { return (0, 0) }
        let lines = s.split(separator: "\n")
        let titled = lines.filter { $0.contains("\"title\":\"") && !$0.contains("\"title\":\"\"") }.count
        return (lines.count, titled)
    }

    /// Title coverage over the last few samples. Used instead of AXIsProcessTrusted for
    /// anything user-facing, because the API answers for this process at this instant while
    /// the samples say whether capture is genuinely working.
    static func recentTitleRate(_ n: Int = 20) -> (samples: Int, titled: Int) {
        guard let s = try? String(contentsOf: raw.appendingPathComponent("\(todayKey()).jsonl"), encoding: .utf8)
        else { return (0, 0) }
        let lines = s.split(separator: "\n").suffix(n)
        let titled = lines.filter { $0.contains("\"title\":\"") && !$0.contains("\"title\":\"\"") }.count
        return (lines.count, titled)
    }

    static func memoryCount(_ date: String = todayKey()) -> Int {
        (try? FileManager.default.contentsOfDirectory(atPath: memories.appendingPathComponent(date).path))?
            .filter { $0.hasSuffix(".md") }.count ?? 0
    }

    /// Which browsers are actually on this Mac, by looking for the history database each
    /// one keeps. Named on the privacy screen so the disclosure is concrete rather than a
    /// generic "your browser".
    static func installedBrowsers() -> [String] {
        let support = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support")
        let candidates: [(String, String)] = [
            ("Chrome", "Google/Chrome/Default/History"),
            ("Brave", "BraveSoftware/Brave-Browser/Default/History"),
            ("Edge", "Microsoft Edge/Default/History"),
            ("Arc", "Arc/User Data/Default/History"),
            ("Vivaldi", "Vivaldi/Default/History"),
            ("Chromium", "Chromium/Default/History"),
        ]
        var found = candidates.filter {
            FileManager.default.fileExists(atPath: support.appendingPathComponent($0.1).path)
        }.map(\.0)
        let safari = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Safari/History.db")
        if FileManager.default.fileExists(atPath: safari.path) { found.append("Safari") }
        return found
    }

    /// The same decision the Node side makes, kept deliberately identical. The sampler runs
    /// in this process, so if these two disagree the app records what the settings forbid.
    static func allows(_ kind: String, _ value: String, _ c: [String: Any] = config()) -> Bool {
        let mode = (c[kind == "app" ? "appMode" : "siteMode"] as? String) ?? "exclude"
        let deny = (c[kind == "app" ? "excludeApps" : "excludeSites"] as? [String]) ?? []
        let allow = (c[kind == "app" ? "includeApps" : "includeSites"] as? [String]) ?? []
        if mode == "include" {
            // Empty allow-list in include mode records nothing. That is what the setting says.
            return allow.contains { matches(value, $0) }
        }
        return !deny.contains { matches(value, $0) }
    }

    static func matches(_ value: String, _ pattern: String) -> Bool {
        let v = value.lowercased(), p = pattern.trimmingCharacters(in: .whitespaces).lowercased()
        if v.isEmpty || p.isEmpty { return false }
        if !p.contains("*") { return v.contains(p) }
        let rx = "^" + p.split(separator: "*", omittingEmptySubsequences: false)
            .map { NSRegularExpression.escapedPattern(for: String($0)) }.joined(separator: ".*") + "$"
        return v.range(of: rx, options: .regularExpression) != nil
    }
}

// MARK: - Capture

final class Sampler {
    private var timer: Timer?
    private(set) var lastApp = ""
    private(set) var lastTitle = ""

    /// Whether this process may read window titles. Asked without prompting, so it can be
    /// polled; `requestAccessibility()` is the one that shows the system dialog.
    static var isTrusted: Bool {
        AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: false] as CFDictionary)
    }

    /// Shows macOS's own Accessibility dialog and adds this app to the list, so nobody has
    /// to navigate a file picker to a path inside a package directory.
    static func requestAccessibility() {
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    }

    static func openAccessibilityPane() {
        if let u = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(u)
        }
    }

    static var idleSeconds: Int {
        Int(CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: .init(rawValue: ~0)!))
    }

    func start() {
        stop()
        let interval = (Store.config()["intervalSec"] as? Int) ?? 15
        timer = Timer.scheduledTimer(withTimeInterval: TimeInterval(interval), repeats: true) { [weak self] _ in
            self?.tick()
        }
        timer?.tolerance = 3
        RunLoop.main.add(timer!, forMode: .common)
        tick()
    }

    func stop() { timer?.invalidate(); timer = nil }

    private func stringAttr(_ el: AXUIElement, _ attr: String) -> String? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return nil }
        return v as? String
    }

    private func windowAttr(_ el: AXUIElement, _ attr: String) -> AXUIElement? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success,
              let val = v, CFGetTypeID(val) == AXUIElementGetTypeID() else { return nil }
        return (val as! AXUIElement)
    }

    func tick() {
        let cfg = Store.config()
        if (cfg["paused"] as? Bool) == true { return }

        let idle = Sampler.idleSeconds
        if idle >= ((cfg["idleMaxSec"] as? Int) ?? 120) { return }

        guard let app = NSWorkspace.shared.frontmostApplication else { return }
        let name = app.localizedName ?? app.bundleIdentifier ?? "unknown"

        // Applied before anything is written, so a blocked app never reaches disk and there
        // is no later filtering step that can be got wrong.
        if !Store.allows("app", name, cfg) { return }

        var title = ""
        if (cfg["captureTitles"] as? Bool) != false, Sampler.isTrusted {
            let ax = AXUIElementCreateApplication(app.processIdentifier)
            if let w = windowAttr(ax, kAXFocusedWindowAttribute as String) ?? windowAttr(ax, kAXMainWindowAttribute as String) {
                title = stringAttr(w, kAXTitleAttribute as String) ?? ""
            }
        }
        let titlePatterns = (cfg["excludeTitlePatterns"] as? [String]) ?? []
        if titlePatterns.contains(where: { Store.matches(title, $0) }) { title = "" }
        title = title.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)

        lastApp = name; lastTitle = title
        Store.appendSample(app: name, title: title, idle: idle)
    }
}

// MARK: - Node bridge
//
// Rollup, search and the viewer stay in the Node package rather than being rewritten in
// Swift. None of them need Accessibility, all of them are already tested, and keeping one
// implementation means the app and the CLI can never disagree about what a memory is.

enum Node {
    static var binary: String? {
        for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        where FileManager.default.isExecutableFile(atPath: p) { return p }
        // Fall back to a login shell so nvm and friends are on PATH.
        let t = Process(); t.executableURL = URL(fileURLWithPath: "/bin/zsh")
        t.arguments = ["-lc", "command -v node"]
        let pipe = Pipe(); t.standardOutput = pipe
        try? t.run(); t.waitUntilExit()
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return out.isEmpty ? nil : out
    }

    /// The bundled copy of the npm package, so the app works without a global install.
    static var cli: String? {
        Bundle.main.resourcePath.map { $0 + "/node/bin/myday.js" }
            .flatMap { FileManager.default.fileExists(atPath: $0) ? $0 : nil }
    }

    @discardableResult
    static func run(_ args: [String], timeout: TimeInterval = 300) -> String {
        guard let node = binary, let cli = cli else { return "" }
        let t = Process()
        t.executableURL = URL(fileURLWithPath: node)
        t.arguments = [cli] + args
        let pipe = Pipe(); t.standardOutput = pipe; t.standardError = pipe
        do { try t.run() } catch { return "" }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        t.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }

    /// The viewer, started as a child process and pointed at by the WKWebView.
    static func startViewer(port: Int) -> Process? {
        guard let node = binary, let cli = cli else { return nil }
        let t = Process()
        t.executableURL = URL(fileURLWithPath: node)
        t.arguments = [cli, "view", "--port", String(port), "--no-open"]
        t.standardOutput = Pipe(); t.standardError = Pipe()
        do { try t.run() } catch { return nil }
        return t
    }
}
