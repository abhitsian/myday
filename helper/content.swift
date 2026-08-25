// On-screen text of the focused window, via Accessibility. Prints JSON on stdout.
//
// The window-title helper answers "which document". This answers "what did it say", by
// reading the value of the focused element and its descendants — the same text a screen
// reader sees. No screenshot, no image on disk, and it uses the Accessibility grant that
// window titles already need.
//
// Bounded on purpose: capped total characters, capped node count, capped depth, hard
// timeout. It reads the dominant on-screen text once, not a full DOM dump.
//
// Build:  swiftc -O helper/content.swift -o bin/content

import Cocoa
import ApplicationServices

let MAX_CHARS = 6000
let MAX_NODES = 400
let MAX_DEPTH = 24

func emit(_ obj: [String: Any]) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(0)
}

guard AXIsProcessTrusted() else { emit(["ok": false, "reason": "not-trusted"]) }
guard let app = NSWorkspace.shared.frontmostApplication else { emit(["ok": false, "reason": "no-frontmost"]) }
let ax = AXUIElementCreateApplication(app.processIdentifier)

func str(_ el: AXUIElement, _ a: String) -> String? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, a as CFString, &v) == .success else { return nil }
    return v as? String
}
func child(_ el: AXUIElement, _ a: String) -> AXUIElement? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, a as CFString, &v) == .success, let r = v,
          CFGetTypeID(r) == AXUIElementGetTypeID() else { return nil }
    return (r as! AXUIElement)
}

var parts: [String] = []
var chars = 0, nodes = 0
let seen = NSMutableSet()

// Only these roles carry page or document content. Buttons, menu items, pop-ups and the
// like are interface chrome — the browser toolbar and its extensions live there, which is
// where "Wants access to this site" was coming from.
let CONTENT_ROLES: Set<String> = ["AXStaticText", "AXTextArea", "AXTextField", "AXText", "AXWebArea", "AXHeading", "AXParagraph"]

func walk(_ el: AXUIElement, _ depth: Int) {
    if depth > MAX_DEPTH || chars >= MAX_CHARS || nodes >= MAX_NODES { return }
    let role = str(el, "AXRole") ?? ""
    if CONTENT_ROLES.contains(role) {
        for a in ["AXValue", "AXSelectedText", "AXDescription"] {
            guard let s = str(el, a) else { continue }
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            if t.count < 3 || seen.contains(t) { continue }
            seen.add(t)
            parts.append(t); chars += t.count; nodes += 1
            break
        }
    }
    var kids: CFTypeRef?
    if AXUIElementCopyAttributeValue(el, "AXChildren" as CFString, &kids) == .success,
       let arr = kids as? [AXUIElement] {
        for k in arr.prefix(120) { walk(k, depth + 1) }
    }
}

// Chromium browsers and some Electron apps build their accessibility tree only when a client
// asks for it. Setting AXManualAccessibility is that request; without it the page body is
// invisible and only the address bar comes back. Harmless on apps that ignore it.
AXUIElementSetAttributeValue(ax, "AXManualAccessibility" as CFString, kCFBooleanTrue)
AXUIElementSetAttributeValue(ax, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
usleep(400_000)

let title = child(ax, "AXFocusedWindow").flatMap { str($0, "AXTitle") } ?? ""
if let w = child(ax, "AXFocusedWindow") { walk(w, 0) }

let text = parts.joined(separator: "\n").prefix(MAX_CHARS)
emit([
    "ok": true,
    "app": app.localizedName ?? "",
    "title": title,
    "text": String(text),
    "chars": text.count,
    "nodes": nodes,
])
