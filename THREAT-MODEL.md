# Threat model

Read this before running backscroll. It records what you do on your computer. That is useful
and it is also a liability, and the second part deserves a document rather than a sentence in
a README.

## What exists on disk

`~/.backscroll/memories/` holds plaintext Markdown describing your working day in ten-minute
resolution: which applications, which web pages, which documents, which projects, when you
were at the machine and when you were not. Weeks of it accumulate.

Nothing is encrypted. Encrypting it would need a key, and a key that a background daemon can
use unattended is a key an attacker who already has your account can also use. Encryption
here would look like protection without being it, so backscroll does not pretend.

## Who can read it

**Anything running as your user.** Every CLI tool, every npm postinstall script, every app you
have granted file access. This is the main risk and it is not one backscroll can fix. If you
run untrusted code as yourself, assume these files are readable.

**Backups.** Time Machine, Backblaze, and any folder sync include `~/.backscroll` unless you
exclude it. The retention promise you make to yourself is only as good as your backup policy.

**Not Spotlight.** `~/.backscroll/.metadata_never_index` is written at setup, so the memories
do not surface in a system-wide search box.

**Not the network.** The viewer binds `127.0.0.1`. There is no HTTP transport on the MCP
server, on purpose: this data has no remote use case worth the exposure.

## What leaves the machine

With `summarizer: local`, the default: nothing.

With `claude-cli` or `api`, two things go out:

- **Rollups.** Every ten minutes, one window's app names, window titles, and page titles.
- **Questions.** When you run `backscroll ask`, the entries selected for that question.

Every send appends a line to `~/.backscroll/egress.log` with a timestamp, the destination
kind, and the size. Nothing else writes to that file.

Your model provider's retention policy applies to what you send. backscroll cannot make a
promise on their behalf.

## Prompt injection

This is the failure mode most people miss, and it is the reason the MCP server is written the
way it is.

Memories are built from text that other people control: web page titles, chat window titles,
document filenames, and a model's summary of those. Nothing stops someone from making a page
whose `<title>` is an instruction. Visit it once and that instruction is in your memory file.

In the viewer that is cosmetic. Over MCP it is not, because the caller is an agent that can
edit files and run commands. So:

- Captured text is never returned as bare context. It comes back inside a fenced
  `<untrusted-data>` envelope.
- `<` and `>` are escaped in the payload, so it cannot close the fence or forge a tag. This is
  the part that actually holds; a fence a payload can close is decoration.
- The rule is restated on every single response rather than assumed to persist from an
  earlier one in the conversation.

This reduces the risk. It does not eliminate it — no envelope makes a model immune to
persuasion. Treat backscroll output the way you treat any untrusted input reaching an agent
with tools. If you run agents that act without review, that is the risk to weigh.

## What is deliberately not captured

No screenshots. No keystrokes. No clipboard. No file contents. No audio. No network traffic.
No location.

Not for lack of feasibility. A memory you can read and correct is one you can consent to, and
a pixel archive is not that.

## Exclusions

Exclusions apply at capture, before anything is written. An excluded app is never on disk
rather than filtered out at read time — there is no later step that can be wrong, and no
window between capture and filter.

The default list covers password managers and obvious credential domains. It is a starting
point, not a considered answer for your life. Add what matters to you: therapy, health
portals, legal, job searching, anything about other people who did not opt into this.

```sh
backscroll config excludeApps "Signal, Messages, 1Password"
backscroll config excludeSites "*bank*, *health*, *therapy*"
backscroll config excludeTitlePatterns "Chat | *"   # keeps the time, drops who
```

That last one matters more than it looks. Chat window titles carry the other person's name,
and they never agreed to be in your log.

## Multi-user and managed machines

Do not run this on an account you do not control. An employer with MDM, or anyone with admin
on the machine, can read these files. A detailed record of your working day in the hands of
someone who can act on it is a different object from a personal note.

## Deletion

`backscroll uninstall` stops the daemon and removes `~/.backscroll` entirely. Individual
memories can be deleted with the × in the viewer or by deleting the file; there is no index to
rebuild and no tombstone left behind.

The Accessibility grant, if you added one, has to be removed by hand in System Settings.
backscroll cannot revoke its own permissions.

## Reporting

Security issues: open an issue, or if it is sensitive, say so in the issue without the details
and a private channel will be arranged.
