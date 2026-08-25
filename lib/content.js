'use strict';
// On-screen content — the text of what you were reading, not just its title.
//
// The window title says "Idempotent requests | Stripe API Reference". The content is what the
// page actually said, so the summariser can write what you learned rather than what you had
// open, and `ask` can answer from the passage instead of the link.
//
// This is the most sensitive thing My Day captures: page bodies are emails, messages and
// documents. So it is off by default, stored apart from the timeline notes, capped hard, and
// bound by the same exclude rules as everything else — an excluded app or site never has its
// body read.
//
// Bounded on purpose. One capture per ten-minute slot, of the dominant window only, not a
// stream. The helper caps characters, nodes and depth; this caps how often and stores the
// result compressed to plain text.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const S = require('./store');

const HELPER = path.join(S.ROOT, 'bin', 'content');
const DIR = path.join(S.ROOT, 'content');
const MAX_STORE = 6000;   // matches the helper's cap; a note is not a document store

// Same key the notes use: slot with the colon stripped, so 09:10 and 0910 are one file.
const slotPath = (date, slot) => path.join(DIR, date, `${String(slot).replace(':', '')}.txt`);

/// Capture the focused window's text now, if the source is on and the app/site is allowed.
/// Returns the stored record or null. Never throws: capture is best-effort and a failure
/// leaves the timeline note exactly as it would have been.
function captureNow(cfg = S.readConfig()) {
  if (!(cfg.sources || {}).content) return null;
  if (!fs.existsSync(HELPER)) return null;
  let out;
  try { out = execFileSync(HELPER, { encoding: 'utf8', timeout: 8000, maxBuffer: 1 << 20 }); }
  catch { return null; }

  let r; try { r = JSON.parse(out); } catch { return null; }
  if (!r.ok || !r.text || r.text.length < 40) return null;

  // The same gate the sampler uses, applied before anything is written. Content from an
  // excluded app or a page whose title matches an excluded site never reaches disk.
  if (S.excludedApp(r.app, cfg)) return null;
  if (r.title && S.excludedTitle(r.title, cfg)) return null;

  const text = String(r.text).slice(0, MAX_STORE).replace(/\n{3,}/g, '\n\n').trim();
  return { app: r.app, title: r.title || '', text };
}

/// Persist one capture for a slot. Only the first capture of a slot is kept, so a slot holds
/// the content of what was in front when it began rather than churning every few seconds.
function store(date, slot, rec) {
  if (!rec || !rec.text) return false;
  const p = slotPath(date, slot);
  if (fs.existsSync(p)) return false;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, rec.text);
  return true;
}

/// The stored content for a slot, or ''. Used by the rollup digest and by ask/MCP.
function read(date, slot) {
  try { return fs.readFileSync(slotPath(date, slot), 'utf8'); } catch { return ''; }
}

/// Content across a day, slot -> text, for the retrieval paths.
function readDay(date) {
  const out = {};
  try {
    for (const f of fs.readdirSync(path.join(DIR, date))) {
      if (f.endsWith('.txt')) out[f.slice(0, -4)] = read(date, f.slice(0, -4));
    }
  } catch {}
  return out;
}

module.exports = { captureNow, store, read, readDay, HELPER, DIR };
