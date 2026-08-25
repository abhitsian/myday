// On-device summariser. Reads a window digest on stdin, prints JSON on stdout.
//
// Apple's FoundationModels runs a model on this Mac, so the default summariser can write real
// sentences without a network call, an API key, or a download. ChatGPT's Computer History
// starts a Codex session to do the same job.
//
// It generates the prose fields only. Apps, sites, times and durations are copied from the
// capture by the caller, because those are aggregated across days and a model that renames
// "Visual Studio Code" to "VS Code" splits a total in half. Asking for the whole Markdown
// file is what made the existing cloud path fall back to `generator: local (unparseable)`.
//
// Build:  swiftc -O helper/summarize.swift -o bin/summarize

import Foundation
import FoundationModels

@Generable
struct Note {
    @Guide(description: "A phrase of four to eight words that begins with a verb ending in -ing and names what was being done. Sentence case: capitalise the first word and proper nouns only. Do not name the application.")
    var title: String

    @Guide(description: "One grammatical sentence of at most 24 words. The first word must be You and the second must be a past-tense verb. Describe only what the capture shows, and say what they did rather than which applications were open.")
    var summary: String

    @Guide(description: "The code project, repository or document being worked on if one is identifiable, otherwise the single character -")
    var project: String

    // No fixed count and no worked examples. Forcing three lines made it invent a third when
    // the capture held two, and a concrete example in this description was copied verbatim
    // into an unrelated window.
    @Guide(description: "One line for each distinct thing the capture shows, at most four. Each line is a grammatical clause beginning with a past-tense verb and naming a file, page, document or person taken from the capture. A bare hostname or title with no verb is not acceptable.", .maximumCount(4))
    var bullets: [String]
}

let INSTRUCTIONS = """
You write one entry in a personal computer-history log, from a record of which applications \
and web pages someone had open during a ten-minute window.

The person will search these later asking things like "what was I debugging yesterday" or \
"where did I leave off". Write so those questions are answerable.

Describe the work, not the software.

Every noun you write must appear in the capture. Do not add page numbers, durations, error \
messages, names or outcomes that are not there. Do not guess what the person concluded or \
what they were trying to achieve. A short entry that is entirely supported is correct; a \
fuller one containing anything invented is a defect, because the person will later trust \
this record against their own memory.

Where the capture is thin, write less.
"""

func fail(_ code: String) -> Never {
    FileHandle.standardError.write(Data("summarize: \(code)\n".utf8))
    exit(1)
}

let model = SystemLanguageModel.default
switch model.availability {
case .available:
    break
case .unavailable(let reason):
    // The caller falls back to its own keyword summariser, so this is a normal outcome on a
    // machine without Apple Intelligence rather than an error worth shouting about.
    fail("unavailable: \(reason)")
@unknown default:
    fail("unavailable: unknown")
}

let digest = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? ""
if digest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { fail("empty input") }

let session = LanguageModelSession(instructions: INSTRUCTIONS)

do {
    let response = try await session.respond(
        to: "Raw capture for this ten-minute window:\n\n\(digest)",
        generating: Note.self
    )
    let n = response.content
    let out: [String: Any] = [
        "title": n.title,
        "summary": n.summary,
        "project": n.project,
        "bullets": n.bullets,
    ]
    let data = try JSONSerialization.data(withJSONObject: out, options: [])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
    fail("generation failed: \(error)")
}
