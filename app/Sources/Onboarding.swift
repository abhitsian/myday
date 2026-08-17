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

enum Step: Int, CaseIterable {
    case welcome, whatYouGet, privacy, permission, writing, done

    var title: String {
        switch self {
        case .welcome:    return "What it does"
        case .whatYouGet: return "What you get"
        case .privacy:    return "Your data"
        case .permission: return "Window titles"
        case .writing:    return "Writing style"
        case .done:       return "Finish"
        }
    }
    var icon: String {
        switch self {
        case .welcome:    return "sparkles"
        case .whatYouGet: return "text.book.closed"
        case .privacy:    return "lock.shield"
        case .permission: return "macwindow"
        case .writing:    return "pencil.line"
        case .done:       return "checkmark.circle"
        }
    }
}

final class OnboardingModel: ObservableObject {
    @Published var step: Step = .welcome
    @Published var trusted: Bool = Sampler.isTrusted
    @Published var summarizer: String = "local"
    @Published var startAtLogin: Bool = true
    @Published var captureBrowsers: Bool = true
    lazy var browsers: [String] = Store.installedBrowsers()
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
        Store.write(["summarizer": summarizer, "onboardedAt": Store.stamp(),
                     "startAtLogin": startAtLogin, "captureBrowsers": captureBrowsers])
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
        .frame(width: 760, height: 480)
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
        case .privacy:    privacy
        case .permission: permission
        case .writing:    writing
        case .done:       done
        }
    }

    // MARK: 1 — what it does

    private var welcome: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Your work, remembered").font(.system(size: 27, weight: .bold)).tracking(-0.4)
            Text("You already forget most of what you did last Tuesday. Your computer doesn't have to.")
                .font(.system(size: 14)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 7)

            VStack(spacing: 0) {
                loopRow("eye", "It watches, quietly",
                        "Which app you're in, which document is open, and which pages you visit — read from your browser's own history.", true)
                loopRow("square.and.pencil", "It writes it down",
                        "Every ten minutes, a short plain-language note. Not screenshots — sentences.", true)
                loopRow("magnifyingglass", "It remembers",
                        "Weeks of notes you can search, or ask questions of in plain English.", true)
                loopRow("bubble.left.and.text.bubble.right", "Your AI assistant reads it",
                        "So you stop opening every session by re-explaining what you were doing.", false)
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
            Text("This is a note").font(.system(size: 24, weight: .bold)).tracking(-0.3)
            Text("One of these lands every ten minutes you're at the machine.")
                .font(.system(size: 13.5)).foregroundStyle(.secondary).padding(.top, 5)

            sampleNote.padding(.top, 18)

            Text("THEN, WEEKS LATER")
                .font(.system(size: 9.5, weight: .semibold)).tracking(0.8)
                .foregroundStyle(.tertiary).padding(.top, 22).padding(.bottom, 9)

            VStack(alignment: .leading, spacing: 7) {
                question("What was I debugging on Tuesday?")
                question("When did I last touch the auth code?")
                question("Where did my week actually go?")
            }

            Text("Ask in the app, or let your coding assistant ask on your behalf mid-task.")
                .font(.system(size: 12)).foregroundStyle(.secondary).padding(.top, 12)
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

    private var privacy: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("What it reads, and what it never touches")
                .font(.system(size: 24, weight: .bold)).tracking(-0.3)
                .fixedSize(horizontal: false, vertical: true)

            HStack(alignment: .top, spacing: 18) {
                privacyCard("checkmark.circle.fill", "Reads", accent, [
                    "Which app is in front, and for how long",
                    "That window's title, if you allow it",
                    "Your browsing history — see below",
                ])
                privacyCard("xmark.circle.fill", "Never touches", Color.secondary, [
                    "Screenshots",
                    "Anything you type",
                    "Clipboard, files, audio",
                ])
            }.padding(.top, 18)

            browserDisclosure.padding(.top, 16)

            VStack(alignment: .leading, spacing: 5) {
                Label("Password managers never reach the disk", systemImage: "lock.fill")
                    .font(.system(size: 12.5, weight: .semibold))
                Text("1Password, Keychain Access, Bitwarden and others are dropped before anything is written, not filtered out afterwards. Add your own at any time, and pause from the menu bar whenever you like.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(13)
            .background(RoundedRectangle(cornerRadius: 9).fill(accent.opacity(0.07)))
            .padding(.top, 14)

            Text("These notes describe your day in detail and they are plain text. Anyone who can run programs as you can read them, so don't turn this on for an account you don't control.")
                .font(.system(size: 11)).foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true).padding(.top, 14)
        }
    }

    /// The one thing people do not expect, so it gets its own block and a switch.
    /// Reading a browser's history file needs no macOS permission at all — there is no
    /// prompt, no padlock, nothing to click. Leaving that implied would be the single most
    /// dishonest thing in the flow, so it is stated outright and can be turned off here.
    private var browserDisclosure: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                Image(systemName: "safari").font(.system(size: 13)).foregroundStyle(accent)
                Text("It reads your browsing history directly")
                    .font(.system(size: 12.5, weight: .semibold))
                Spacer(minLength: 0)
                Toggle("", isOn: $model.captureBrowsers).labelsHidden().controlSize(.small)
            }
            Text(model.browsers.isEmpty
                 ? "No supported browser found on this Mac."
                 : "My Day opens the history database that \(model.browsers.joined(separator: ", ")) already keep\(model.browsers.count == 1 ? "s" : "") on this Mac, and reads the page titles and addresses from it. macOS does not prompt for this and there is no permission to grant — which is exactly why it is being said here rather than left for you to discover.")
                .font(.system(size: 12)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text("It reads a copy, never writes, and skips private windows. Sites matching your exclude list are dropped before anything is saved. Switch it off and My Day still records apps and window titles.")
                .font(.system(size: 11.5)).foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(13)
        .background(
            RoundedRectangle(cornerRadius: 9)
                .fill(Color(nsColor: .textBackgroundColor))
                .overlay(RoundedRectangle(cornerRadius: 9).stroke(accent.opacity(0.35), lineWidth: 1.2))
        )
    }

    private func privacyCard(_ icon: String, _ title: String, _ tint: Color, _ items: [String]) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 6) {
                Image(systemName: icon).font(.system(size: 12)).foregroundStyle(tint)
                Text(title).font(.system(size: 12.5, weight: .semibold))
            }
            ForEach(items, id: \.self) { i in
                HStack(alignment: .top, spacing: 7) {
                    Circle().fill(Color.secondary.opacity(0.35)).frame(width: 3, height: 3).padding(.top, 6)
                    Text(i).font(.system(size: 12.5)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(13)
        .background(
            RoundedRectangle(cornerRadius: 9)
                .fill(Color(nsColor: .textBackgroundColor))
                .overlay(RoundedRectangle(cornerRadius: 9).stroke(Color.secondary.opacity(0.14), lineWidth: 1))
        )
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

    // MARK: 5 — writing

    private var writing: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Who writes the notes").font(.system(size: 24, weight: .bold)).tracking(-0.3)
            Text("You can change this later, and switch it off entirely at any time.")
                .font(.system(size: 13.5)).foregroundStyle(.secondary).padding(.top, 5)

            VStack(spacing: 9) {
                choice("local", "This Mac", "Nothing leaves",
                       "A plain list of the apps and pages in each ten minutes. No model, no network, no cost.")
                choice("claude-cli", "Claude Code", "Recommended",
                       "Real sentences, like the note you just saw. Uses the claude command already on your Mac. Each ten-minute window is sent to the model.")
                choice("api", "An API key", nil,
                       "The same, via ANTHROPIC_API_KEY. Roughly fifty short requests a day.")
            }.padding(.top, 18)

            Text("Every send is appended to ~/.myday/egress.log, so “what left my machine, and when” has an answer you can read rather than take on trust.")
                .font(.system(size: 11)).foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true).padding(.top, 14)
        }
    }

    private func choice(_ id: String, _ title: String, _ tag: String?, _ desc: String) -> some View {
        Button {
            model.summarizer = id
        } label: {
            HStack(alignment: .top, spacing: 11) {
                Image(systemName: model.summarizer == id ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(model.summarizer == id ? accent : Color.secondary.opacity(0.5))
                    .font(.system(size: 15))
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(title).font(.system(size: 13.5, weight: .semibold))
                        if let tag {
                            Text(tag)
                                .font(.system(size: 9.5, weight: .semibold)).tracking(0.3)
                                .foregroundStyle(accent)
                                .padding(.horizontal, 5).padding(.vertical, 1.5)
                                .background(Capsule().fill(accent.opacity(0.13)))
                        }
                    }
                    Text(desc).font(.system(size: 12)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true).multilineTextAlignment(.leading)
                }
                Spacer(minLength: 0)
            }
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 9)
                .fill(model.summarizer == id ? accent.opacity(0.08) : Color(nsColor: .controlBackgroundColor)))
            .overlay(RoundedRectangle(cornerRadius: 9)
                .stroke(model.summarizer == id ? accent.opacity(0.45) : .clear, lineWidth: 1.2))
        }
        .buttonStyle(.plain)
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

            Toggle("Start My Day when I log in", isOn: $model.startAtLogin)
                .font(.system(size: 12.5)).padding(.top, 16)
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
        case .privacy: return "I understand"
        default:       return "Continue"
        }
    }

    private func advance() {
        if model.step == .done { model.finish(); onDone(); return }
        // Capture begins once the privacy screen has been acknowledged, not at the end of
        // the flow, so the permission and writing screens are chosen with real notes
        // already accumulating behind them.
        if model.step == .privacy { Store.ensure(); Store.write([:]) }
        model.step = Step(rawValue: model.step.rawValue + 1) ?? .done
    }
}
