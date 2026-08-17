// frontwindow — prints the frontmost app and its front window title as "app\ttitle".
//
// This exists so the Accessibility grant can be scoped to one binary instead of to
// /usr/bin/osascript. Granting osascript assistive access hands it to every AppleScript
// anything on the machine runs, including the ability to synthesize clicks and keystrokes.
// This binary only ever reads two attributes and prints them.
//
// The app name comes from NSWorkspace and needs no permission at all. Only the window
// title goes through the Accessibility API, so a denied grant degrades to app-name-only
// rather than to nothing.
//
// Build (see `backscroll build-helper` — the ad-hoc signature is part of the TCC identity, so rebuilding
// invalidates the Accessibility grant and the entry has to be removed and re-added):
//   swiftc -O -o helper/frontwindow helper/frontwindow.swift
//   codesign --force --sign - --identifier com.backscroll.frontwindow helper/frontwindow
//
// Exit codes: 0 ok · 2 not trusted for Accessibility (title empty) · 1 no frontmost app.
// The caller uses 2 to tell "no permission" apart from "this window has no title", which
// lets `backscroll status` report the real state instead of showing empty titles.

import Cocoa
import ApplicationServices

let trusted = AXIsProcessTrusted()

if CommandLine.arguments.contains("--check") {
    print(trusted ? "trusted" : "not-trusted")
    exit(trusted ? 0 : 2)
}

guard let app = NSWorkspace.shared.frontmostApplication else {
    FileHandle.standardError.write(Data("frontwindow: no frontmost application\n".utf8))
    exit(1)
}

let name = app.localizedName ?? app.bundleIdentifier ?? "unknown"

func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
    return value as? String
}

func windowAttribute(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
          let v = value, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
    return (v as! AXUIElement)
}

var title = ""
if trusted {
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    // Focused window first; some apps (Finder, menu-bar-driven apps) only answer main.
    let window = windowAttribute(axApp, kAXFocusedWindowAttribute as String)
        ?? windowAttribute(axApp, kAXMainWindowAttribute as String)
    if let w = window {
        title = stringAttribute(w, kAXTitleAttribute as String) ?? ""
    }
}

// Tabs and newlines would corrupt the caller's field split and the JSONL line.
let clean = title.replacingOccurrences(of: "\t", with: " ")
    .replacingOccurrences(of: "\n", with: " ")
    .trimmingCharacters(in: .whitespacesAndNewlines)

print("\(name)\t\(clean)")
exit(trusted ? 0 : 2)
