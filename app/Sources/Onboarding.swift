import SwiftUI
import AppKit
import ServiceManagement

// Onboarding.swift — six screens, with a sidebar so you can always see where you are and
// what is still coming.
//
// The order carries an argument. What the thing does, then what you actually get out of it,
// then what it costs you in privacy, and only then the permission request. A memory tool
// that opens by demanding an invasive permission has to be trusted on a promise. This one
// shows a real note first and asks second, which is the honest order and also the
// persuasive one.

// Five screens. "Writing style" used to be one of them and is now a setting: it asked people
// to choose who writes their notes before they knew what a note was for, which is a decision
// about an implementation detail dressed up as a first-run question.
enum Step: Int, CaseIterable {
    case welcome, whatYouGet, sources, permission, done

    var title: String {
        switch self {
        case .welcome:    return "What it does"
        case .whatYouGet: return "What you can ask"
        case .sources:    return "What it reads"
        case .permission: return "Window titles"
        case .done:       return "Finish"
        }
    }
    var icon: String {
        switch self {
        case .welcome:    return "sparkles"
        case .whatYouGet: return "bubble.left.and.text.bubble.right"
        case .sources:    return "lock.shield"
        case .permission: return "macwindow"
        case .done:       return "checkmark.circle"
        }
    }
}

final class OnboardingModel: ObservableObject {
    @Published var step: Step = .welcome
    @Published var trusted: Bool = Sampler.isTrusted
    // Each source is its own decision. Claude Code was previously switched on without ever
    // being mentioned, which is a consent gap however useful the data is.
    @Published var useBrowsing: Bool = true
    @Published var useClaudeCode: Bool = true
    @Published var startAtLogin: Bool = true
    @Published var backfill: Bool = true
    lazy var browsers: [String] = Store.installedBrowsers()
    lazy var hasClaudeCode: Bool = FileManager.default.fileExists(
        atPath: FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".claude/projects").path)
    private var poll: Timer?

    /// The grant lands only after the person acts in System Settings, so the screen watches
    /// for it rather than asking them to come back and press a refresh button.
    func watchForGrant() {
        poll?.invalidate()
        poll = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            let now = Sampler.isTrusted
            if now != self.trusted { DispatchQueue.main.async { self.trusted = now } }
        }
    }
    func stopWatching() { poll?.invalidate(); poll = nil }

    func finish() {
        Store.ensure()
        Store.write([
            "onboardedAt": Store.stamp(),
            "startAtLogin": startAtLogin,
            "captureBrowsers": useBrowsing,
            "sources": ["browser": useBrowsing, "claudeCode": useClaudeCode],
        ])
        applyLoginItem()
        stopWatching()
    }

    /// A checkbox that does nothing is worse than no checkbox. SMAppService registers the
    /// bundle with macOS directly; it needs no helper and no login-items plist.
    func applyLoginItem() {
        do {
            if startAtLogin {
                if SMAppService.mainApp.status != .enabled { try SMAppService.mainApp.register() }
            } else if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            NSLog("[myday] login item: \(error.localizedDescription)")
        }
    }
}

struct OnboardingView: View {
    @ObservedObject var model: OnboardingModel
    var onDone: () -> Void

    private let accent = Color(red: 0.31, green: 0.40, blue: 0.62)

    var body: some View {
        HStack(spacing: 0) {
            sidebar
            Divider()
            VStack(spacing: 0) {
                ScrollView(.vertical, showsIndicators: false) {
                    content
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                        .padding(.horizontal, 34).padding(.top, 34).padding(.bottom, 20)
                }
                Divider()
                footer.padding(.horizontal, 26).padding(.vertical, 14)
            }
        }
        .frame(width: 760, height: 560)
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear { model.watchForGrant() }
        .onDisappear { model.stopWatching() }
    }

    // MARK: sidebar

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 9) {
                ZStack {
                    RoundedRectangle(cornerRadius: 7).fill(accent)
                    Image(systemName: "clock.arrow.circlepath")
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                }.frame(width: 26, height: 26)
                Text("My Day").font(.system(size: 15, weight: .semibold))
            }
            .padding(.horizontal, 18).padding(.top, 22).padding(.bottom, 20)

            ForEach(Step.allCases, id: \.rawValue) { s in
                HStack(spacing: 9) {
                    Image(systemName: s.rawValue < model.step.rawValue ? "checkmark.circle.fill" : s.icon)
                        .font(.system(size: 12))
                        .foregroundStyle(s.rawValue < model.step.rawValue ? accent
                                         : (s == model.step ? accent : Color.secondary.opacity(0.55)))
                        .frame(width: 16)
                    Text(s.title)
                        .font(.system(size: 12.5, weight: s == model.step ? .semibold : .regular))
                        .foregroundStyle(s == model.step ? Color.primary : Color.secondary)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 14).padding(.vertical, 7)
                .background(
                    RoundedRectangle(cornerRadius: 7)
                        .fill(s == model.step ? accent.opacity(0.11) : .clear)
                        .padding(.horizontal, 8)
                )
            }
            Spacer()
            Text("Everything stays\non this Mac.")
                .font(.system(size: 10.5)).foregroundStyle(.tertiary)
                .padding(.horizontal, 18).padding(.bottom, 18)
        }
        .frame(width: 186)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.5))
    }

    @ViewBuilder private var content: some View {
        switch model.step {
        case .welcome:    welcome
        case .whatYouGet: whatYouGet
        case .sources:    sources
        case .permission: permission
        case .done:       done
        }
    }

    // MARK: 1 — what it does

    private var welcome: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Your work, remembered").font(.system(size: 27, weight: .bold)).tracking(-0.4)
            Text("You already forget most of what you did last Tuesday. Your Mac doesn't have to.")
                .font(.system(size: 14)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true).padding(.top, 7)

            VStack(spacing: 0) {
                loopRow("eye", "It notices what you are working on",
                        "The app in front, the page you are reading, the project you are in. No screenshots and nothing you type.", true)
                loopRow("square.and.pencil", "It keeps a record you can read",
                        "A few plain sentences every ten minutes, stored as ordinary text files on this Mac.", true)
                loopRow("magnifyingglass", "You can ask it things later",
                        "What was I debugging on Tuesday. Where did I leave off. Which work has gone quiet.", true)
                loopRow("bubble.left.and.text.bubble.right", "So can your AI assistant",
                        "Claude Code, Cursor and Zed can read it mid-task, so you stop re-explaining what you were doing.", false)
            }
            .padding(.top, 22)
        }
    }

    private func loopRow(_ icon: String, _ title: String, _ body: String, _ connector: Bool) -> some View {
        HStack(alignment: .top, spacing: 13) {
            VStack(spacing: 0) {
                ZStack {
                    Circle().fill(accent.opacity(0.13))
                    Image(systemName: icon).font(.system(size: 12, weight: .medium)).foregroundStyle(accent)
                }.frame(width: 28, height: 28)
                if connector {
                    Rectangle().fill(accent.opacity(0.18)).frame(width: 1.5).frame(maxHeight: .infinity)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 13.5, weight: .semibold))
                Text(body).font(.system(size: 12.5)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.bottom, connector ? 16 : 0)
            Spacer(minLength: 0)
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: 2 — what you get

    private var whatYouGet: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("What you get out of it").font(.system(size: 24, weight: .bold)).tracking(-0.3)
            Text("The record is the raw material. These are the things it answers.")
                .font(.system(size: 13.5)).foregroundStyle(.secondary).padding(.top, 5)

            VStack(alignment: .leading, spacing: 13) {
                payoff("clock.arrow.circlepath", "Where you left off",
                       "Pick a thread back up without reconstructing it from an open tab.")
                payoff("point.3.connected.trianglepath.dotted", "The work that keeps recurring",
                       "Grouped for you across days. Nothing to tag, nothing to fill in.")
                payoff("exclamationmark.arrow.circlepath", "What keeps costing you",
                       "Signing in to the same site 29 times a week is a setting, not a habit.")
                payoff("magnifyingglass", "That thing you read in March",
                       "Searchable months later, with what you were working on at the time.")
            }.padding(.top, 20)

            sampleNote.padding(.top, 20)
        }
    }

    private func payoff(_ icon: String, _ title: String, _ body: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).font(.system(size: 14)).foregroundStyle(accent)
                .frame(width: 20).padding(.top, 1)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 13.5, weight: .semibold))
                Text(body).font(.system(size: 12.5)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
    }

    private var sampleNote: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 13) {
                VStack(alignment: .leading, spacing: 1) {
                    Text("09:10").font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                    Text("09:20").font(.system(size: 11.5, design: .monospaced)).foregroundStyle(.tertiary)
                }.frame(width: 46, alignment: .leading)
                VStack(alignment: .leading, spacing: 5) {
                    Text("Tracing the webhook retry loop").font(.system(size: 14, weight: .semibold))
                    Text("Read Stripe's idempotency docs, then edited retry.ts.")
                        .font(.system(size: 12.5)).foregroundStyle(.secondary)
                    HStack(spacing: 5) {
                        ForEach(["Code", "Chrome", "stripe.com", "backend-api"], id: \.self) { chip($0) }
                    }.padding(.top, 2)
                }
                Spacer(minLength: 0)
            }
            .padding(15)
        }
        .background(
            RoundedRectangle(cornerRadius: 11)
                .fill(Color(nsColor: .textBackgroundColor))
                .overlay(RoundedRectangle(cornerRadius: 11).stroke(Color.secondary.opacity(0.16), lineWidth: 1))
        )
    }

    private func chip(_ s: String) -> some View {
        Text(s)
            .font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
            .padding(.horizontal, 6).padding(.vertical, 2.5)
            .background(RoundedRectangle(cornerRadius: 5).fill(Color.secondary.opacity(0.10)))
    }

    private func question(_ s: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "arrow.turn.down.right")
                .font(.system(size: 10)).foregroundStyle(accent.opacity(0.65))
            Text(s).font(.system(size: 13)).italic()
        }
    }

    // MARK: 3 — privacy

    private var sources: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("What it reads").font(.system(size: 24, weight: .bold)).tracking(-0.3)
            Text("Three sources, each its own decision. Switch any of them off now or later.")
                .font(.system(size: 13.5)).foregroundStyle(.secondary).padding(.top, 5)

            VStack(spacing: 9) {
                sourceRow(icon: "macwindow", name: "Apps and windows", always: true, on: .constant(true),
                          detail: "Which app is in front, and for how long.",
                          note: "Needed for anything else to make sense.")
                sourceRow(icon: "safari", name: "Browsing", always: false, on: $model.useBrowsing,
                          detail: model.browsers.isEmpty
                            ? "No supported browser found on this Mac."
                            : "Page titles and addresses from \(model.browsers.joined(separator: ", ")).",
                          note: "Read from the history your browser already keeps. macOS does not prompt for this, which is why it is being said here. Private windows are never included.")
                sourceRow(icon: "terminal", name: "Claude Code", always: false, on: $model.useClaudeCode,
                          detail: model.hasClaudeCode
                            ? "The project you worked in, what you asked for, and a way back into the session."
                            : "Not installed — nothing to read.",
                          note: "Reads session transcripts already on disk.")
            }.padding(.top, 18)

            VStack(alignment: .leading, spacing: 5) {
                Label("Never recorded", systemImage: "xmark.shield")
                    .font(.system(size: 12.5, weight: .semibold))
                Text("Screenshots, anything you type, your clipboard, file contents, audio. Password managers are dropped before anything is written, and you can add your own exclusions at any time.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(13)
            .background(RoundedRectangle(cornerRadius: 9).fill(accent.opacity(0.07)))
            .padding(.top, 16)

            Text("These files describe your day in detail and they are plain text. Anyone who can run programs as you can read them, so don't turn this on for an account you don't control.")
                .font(.system(size: 11)).foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true).padding(.top, 13)
        }
    }

    private func sourceRow(icon: String, name: String, always: Bool,
                           on: Binding<Bool>, detail: String, note: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).font(.system(size: 15)).foregroundStyle(accent)
                .frame(width: 22).padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                Text(name).font(.system(size: 13.5, weight: .semibold))
                Text(detail).font(.system(size: 12.5)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(note).font(.system(size: 11)).foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            if always {
                Text("always").font(.system(size: 10.5)).foregroundStyle(.tertiary).padding(.top, 4)
            } else {
                Toggle("", isOn: on).labelsHidden().controlSize(.small).padding(.top, 1)
            }
        }
        .padding(13)
        .background(RoundedRectangle(cornerRadius: 9).fill(Color(nsColor: .controlBackgroundColor)))
    }

    // MARK: 4 — permission

    private var permission: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Make the notes specific").font(.system(size: 24, weight: .bold)).tracking(-0.3)
            Text("Optional. Skip it and My Day still works — the notes are just vaguer.")
                .font(.system(size: 13.5)).foregroundStyle(.secondary).padding(.top, 5)

            VStack(spacing: 9) {
                beforeAfter("Without", "Microsoft Teams · 40m", false)
                beforeAfter("With", "Teams — Design review with the platform team", true)
            }.padding(.top, 18)

            Text("macOS calls this Accessibility. My Day uses it to read one thing: the title of the window in front of you. It cannot see inside the window, and it never types or clicks.")
                .font(.system(size: 12.5)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true).padding(.top, 16)

            if model.trusted {
                HStack(spacing: 7) {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                    Text("Allowed. Window titles are being recorded.")
                        .font(.system(size: 13, weight: .medium))
                }
                .padding(.vertical, 10).padding(.horizontal, 13)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.green.opacity(0.10)))
                .padding(.top, 16)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    Button {
                        Sampler.requestAccessibility()
                        Sampler.openAccessibilityPane()
                    } label: {
                        Text("Allow window titles…").frame(minWidth: 150)
                    }
                    .buttonStyle(.borderedProminent).controlSize(.large)
                    Text("System Settings will open. Switch on “My Day” in the list — this screen notices by itself.")
                        .font(.system(size: 11.5)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }.padding(.top, 16)
            }
        }
    }

    private func beforeAfter(_ label: String, _ value: String, _ good: Bool) -> some View {
        HStack(spacing: 12) {
            Text(label)
                .font(.system(size: 10.5, weight: .semibold)).tracking(0.4)
                .foregroundStyle(good ? accent : Color.secondary)
                .frame(width: 54, alignment: .leading)
            Text(value)
                .font(.system(size: 12.5, design: .monospaced))
                .foregroundStyle(good ? Color.primary : Color.secondary)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 13).padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(good ? accent.opacity(0.09) : Color(nsColor: .controlBackgroundColor))
        )
    }

    // MARK: 6 — done

    private var done: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 9) {
                Image(systemName: "checkmark.circle.fill").font(.system(size: 21)).foregroundStyle(accent)
                Text("Recording").font(.system(size: 24, weight: .bold)).tracking(-0.3)
            }
            Text("My Day is in your menu bar. Your first note appears within ten minutes, and there is nothing else to do.")
                .font(.system(size: 13.5)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true).padding(.top, 6)

            VStack(alignment: .leading, spacing: 11) {
                tip("menubar.arrow.up.rectangle", "The menu bar icon opens your day, pauses recording, or quits.")
                tip("calendar", "Come back tomorrow — a week of notes is where it starts being useful.")
            }.padding(.top, 20)

            VStack(alignment: .leading, spacing: 7) {
                Text("Connect your AI coding assistant").font(.system(size: 13, weight: .semibold))
                Text("Add this to your MCP configuration and it can search your history mid-task, instead of asking you what you were doing.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text("\"myday\": { \"command\": \"myday-mcp\" }")
                    .font(.system(size: 11.5, design: .monospaced))
                    .padding(9)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 7).fill(Color(nsColor: .textBackgroundColor)))
                    .overlay(RoundedRectangle(cornerRadius: 7).stroke(Color.secondary.opacity(0.16), lineWidth: 1))
                    .textSelection(.enabled)
            }
            .padding(13)
            .background(RoundedRectangle(cornerRadius: 9).fill(Color(nsColor: .controlBackgroundColor)))
            .padding(.top, 20)

            // The cold start is the real retention problem: threads and comparisons need
            // weeks, so a fresh install is least impressive exactly when someone decides
            // whether to keep it. The browser has months of history already and reading it
            // costs no permission, so day one can show a populated product.
            if model.useBrowsing {
                VStack(alignment: .leading, spacing: 3) {
                    Toggle("Fill in the last 60 days from my browser history", isOn: $model.backfill)
                        .font(.system(size: 12.5))
                    Text("Runs once in the background. Without it, My Day has nothing to show until you have used it for a couple of weeks.")
                        .font(.system(size: 11)).foregroundStyle(.tertiary)
                        .fixedSize(horizontal: false, vertical: true).padding(.leading, 21)
                }.padding(.top, 14)
            }
            Toggle("Start My Day when I log in", isOn: $model.startAtLogin)
                .font(.system(size: 12.5)).padding(.top, 10)

            Text("Notes are written on this Mac with no model and no network. Settings can hand that job to Claude instead, for fuller sentences.")
                .font(.system(size: 11)).foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true).padding(.top, 10)
        }
    }

    private func tip(_ icon: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon).font(.system(size: 13)).foregroundStyle(accent).frame(width: 18)
            Text(text).font(.system(size: 12.5)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
    }

    // MARK: chrome

    private var footer: some View {
        HStack {
            if model.step != .welcome {
                Button("Back") { model.step = Step(rawValue: model.step.rawValue - 1) ?? .welcome }
                    .buttonStyle(.plain).foregroundStyle(.secondary).font(.system(size: 12.5))
            }
            Spacer()
            if model.step == .permission && !model.trusted {
                Button("Skip for now") { advance() }
                    .buttonStyle(.plain).foregroundStyle(.secondary).font(.system(size: 12.5))
                    .padding(.trailing, 6)
            }
            Button(primaryLabel) { advance() }
                .buttonStyle(.borderedProminent).controlSize(.large)
                .keyboardShortcut(.defaultAction)
        }
    }

    private var primaryLabel: String {
        switch model.step {
        case .done:    return "Start recording"
        case .sources: return "I understand"
        default:       return "Continue"
        }
    }

    private func advance() {
        if model.step == .done { model.finish(); onDone(); return }
        // Capture begins once the privacy screen has been acknowledged, not at the end of
        // the flow, so the permission and writing screens are chosen with real notes
        // already accumulating behind them.
        // Capture begins once the sources screen has been acknowledged, so the permission
        // and finish screens are decided with real notes already accumulating behind them.
        if model.step == .sources { Store.ensure(); Store.write([:]) }
        model.step = Step(rawValue: model.step.rawValue + 1) ?? .done
    }
}
