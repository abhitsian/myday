# backscroll

A private, local memory of what you did on your Mac. Every ten minutes it writes one small
Markdown file describing what you were working on. You can search those files, ask questions
of them, and let your AI coding agent read them over MCP.

No screenshots. No keystrokes. No account. Nothing leaves the machine unless you turn that on.

```
backscroll show

  09:10  Tracing the webhook retry loop
  09:20      Read Stripe's idempotency docs, then edited retry.ts
             Code, Google Chrome · stripe.com, github.com · backend-api

  09:20  Standup, then back into retry handling
  09:30      Zoom call, then straight back to retry.ts and the failing test
             zoom.us, Code, Terminal · backend-api
```

## Why

Your agent starts every session knowing nothing about your week. You re-explain what you were
doing, which file you were in, what you already tried. Meanwhile the machine knew all of it.

backscroll writes that down in a form both you and an agent can read.

```
$ backscroll ask "what was I debugging yesterday"

The retry loop in retry.ts — specifically idempotency-key reuse on retried
webhook deliveries (2026-08-16 09:10). You read Stripe's idempotency docs
(09:20), then spent the afternoon on the failing test in retry.test.ts
(14:00–15:30). You left off with the test still red.
```

## Install

```sh
npm install -g backscroll
backscroll init      # explains exactly what gets captured, then asks
backscroll start     # begins recording
```

macOS only. Node 18+.

## It works before you grant it anything

Three tiers. Each one is useful, and you opt into the next only if you want it.

| Tier | Needs | You get |
|---|---|---|
| 1 | nothing at all | Which app was in front, and for how long |
| 2 | nothing at all | Page titles and URLs, read from your browser's own history DB |
| 3 | Accessibility, for one binary | Window titles — the document, the chat, the folder |

Most tools in this category demand accessibility before they show you anything, so you have
to trust them on a promise. Here you can run tiers 1 and 2 for a week and read the output
first.

For tier 3:

```sh
backscroll build-helper
# then grant Accessibility to just the printed binary path
```

The helper is [60 lines of Swift](helper/frontwindow.swift) that reads two attributes and
prints them. The alternative most tools use is granting `/usr/bin/osascript` accessibility,
which hands it to every AppleScript on your machine, including keystroke and click synthesis.

## Use it from your agent

```jsonc
// ~/.claude.json  →  mcpServers
"backscroll": { "command": "backscroll-mcp" }
```

Four tools: `history_search`, `history_window`, `history_resume`, `history_time_by`.

Then, in any session: *"pick up where I left off"*, *"when did I last touch the auth code"*,
*"where did my week actually go"*.

## Summaries

By default summaries are written locally with no model and no network — plain digests of what
was captured. To get real prose:

```sh
backscroll config summarizer claude-cli   # uses your Claude Code CLI
backscroll config summarizer api          # uses ANTHROPIC_API_KEY
```

That is roughly 40–55 short calls a day. Every one is recorded in `~/.backscroll/egress.log`,
so "what left my machine, and when" is a question with a file-backed answer.

## Privacy

Exclusions apply **before anything is written to disk**, so an excluded app is never recorded
rather than filtered out later.

```sh
backscroll config excludeApps "1Password, Keychain Access, Signal"
backscroll config excludeSites "*bank*, *health*, therapist.example.com"
backscroll config excludeTitlePatterns "Chat | *"   # blank the title, keep the time
backscroll config paused true                        # stop recording, keep what exists
```

Read [THREAT-MODEL.md](THREAT-MODEL.md) before deciding to run this. The short version: these
files describe your day in detail, they are plaintext, and anyone who can run code as you can
read them.

## Everything is a file

```
~/.backscroll/
  config.json
  raw/2026-08-17.jsonl          samples, deleted after 14 days
  memories/2026-08-17/0910.md   one per 10 minutes, kept
  egress.log                    every byte that left, with a timestamp
```

A memory:

```markdown
---
start: 09:10
end: 09:20
title: Tracing the webhook retry loop
summary: Read Stripe idempotency docs, then edited retry.ts.
apps: Code, Google Chrome
sites: stripe.com, github.com
project: backend-api
active: 540
generator: claude-cli
---

- Reading Stripe's idempotency-key docs on retried webhook deliveries
- Editing retry.ts, focused on the reuse path
```

Edit them. Delete them. `grep` them. There is no database and no export step.

## Commands

```
backscroll init | start | stop | status | uninstall
backscroll show [--date D] | search <query> | ask "<question>" | view
backscroll rollup [--date D] [--backfill N] [--force]
backscroll config [key] [value]
backscroll build-helper
```

`backscroll uninstall` stops the daemon and deletes every file it created.

## Prior art

OpenAI shipped Computer History in the ChatGPT Mac app in August 2026 — the same idea:
interaction events rather than screenshots, rolled up on a ten-minute cadence into Markdown
memory files. Windows Recall and Rewind took the screenshot route.

backscroll differs on three things: it works at tier 1 with no permission at all, it reads
page detail from the browser's history DB rather than scraping the window, and it is a local
file tree with an MCP server rather than a feature inside one assistant.

MIT.
