'use strict';
// Paths, config, and the memory files. Everything myday knows lives under ~/.myday.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.MYDAY_HOME || path.join(os.homedir(), '.myday');
const RAW = path.join(ROOT, 'raw');
const MEM = path.join(ROOT, 'memories');
const CONFIG = path.join(ROOT, 'config.json');
const EGRESS = path.join(ROOT, 'egress.log');
const SLOT_MIN = 10;

// Defaults are deliberately stricter than a personal build would need. summarizer:'local'
// means a fresh install sends nothing anywhere until the user opts in, so the tool is
// useful before it is trusted rather than the other way round.
const DEFAULTS = {
  paused: false,
  summarizer: 'local',            // 'local' | 'claude-cli' | 'api'
  model: 'claude-haiku-4-5-20251001',
  excludeApps: [
    '1Password', 'Passwords', 'Keychain Access', 'Bitwarden', 'LastPass', 'Dashlane',
    'Authenticator', 'Tor Browser',
  ],
  excludeSites: [
    '*password*', '*bank*', 'accounts.google.com', 'login.microsoftonline.com',
    '*.onlinebanking.*', 'health.*', '*medical*', 'localhost:*/admin*',
  ],
  excludeTitlePatterns: [],       // titles matching these are blanked, the slot still records
  // Two ways to decide, per kind. 'exclude' blocks what you name and allows the rest;
  // 'include' allows only what you name and blocks the rest. An allow-list is the stronger
  // posture and some people want it, but it is the wrong default: it starts empty, so it
  // would record nothing and look broken.
  appMode: 'exclude',             // 'exclude' | 'include'
  includeApps: [],
  siteMode: 'exclude',            // 'exclude' | 'include'
  includeSites: [],
  captureTitles: true,            // needs the helper + Accessibility; app names work regardless
  captureBrowsers: true,
  browsers: ['Chrome', 'Brave', 'Edge', 'Arc', 'Vivaldi'],
  rawRetentionDays: 14,
  intervalSec: 15,
  idleMaxSec: 120,
  helperSignature: null,   // cdhash at the time the helper was last built; a change means a stale TCC grant
};

function ensure() {
  for (const d of [ROOT, RAW, MEM]) fs.mkdirSync(d, { recursive: true });
  // Keep the memories out of Spotlight. They are plain text describing everything the
  // user did; there is no reason for them to surface in a system-wide search box.
  const marker = path.join(ROOT, '.metadata_never_index');
  if (!fs.existsSync(marker)) fs.writeFileSync(marker, '');
}

function readConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}
function writeConfig(patch) {
  ensure();
  const next = { ...readConfig(), ...patch };
  fs.writeFileSync(CONFIG, JSON.stringify(next, null, 2));
  return next;
}
const initialized = () => fs.existsSync(CONFIG);

// `*` is the only wildcard. A bare pattern is a substring match so "1Password" catches
// "1Password 7"; a pattern containing `*` is anchored so "health.*" cannot match
// "mentalhealthfoundation.org" by accident.
function matches(value, pattern) {
  const v = String(value || '').toLowerCase(), p = String(pattern || '').trim().toLowerCase();
  if (!v || !p) return false;
  if (!p.includes('*')) return v.includes(p);
  const rx = new RegExp('^' + p.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return rx.test(v);
}
// One decision function for both modes, so a new call site cannot accidentally honour the
// deny-list and ignore the allow-list.
function allows(kind, value, c = readConfig()) {
  const mode = kind === 'app' ? (c.appMode || 'exclude') : (c.siteMode || 'exclude');
  const deny = kind === 'app' ? (c.excludeApps || []) : (c.excludeSites || []);
  const allow = kind === 'app' ? (c.includeApps || []) : (c.includeSites || []);
  if (mode === 'include') {
    // An empty allow-list in include mode means nothing is recorded. That is the honest
    // reading of "include only these", and the UI says so rather than silently recording.
    return allow.some((p) => matches(value, p));
  }
  return !deny.some((p) => matches(value, p));
}

const excludedApp = (app, c) => !allows('app', app, c);
const excludedSite = (u, c) => !allows('site', u, c);
const excludedTitle = (t, c) => (c.excludeTitlePatterns || []).some((p) => matches(t, p));

/// Add or remove a pattern from whichever list the current mode is using.
function setRule(kind, value, on, c = readConfig()) {
  const mode = kind === 'app' ? (c.appMode || 'exclude') : (c.siteMode || 'exclude');
  const key = mode === 'include'
    ? (kind === 'app' ? 'includeApps' : 'includeSites')
    : (kind === 'app' ? 'excludeApps' : 'excludeSites');
  const list = new Set(c[key] || []);
  // In exclude mode "on" means excluded; in include mode it means allowed. Either way the
  // caller is saying "this value should be in the list the mode is reading".
  if (on) list.add(value); else list.delete(value);
  return writeConfig({ [key]: [...list] });
}

// ---- dates + slots ----
const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// Local time, deliberately, with no zone suffix. `new Date("2026-08-17T11:00:00")` parses
// back as local, so stamp and parse agree. toISOString() here would write UTC into a
// local-dated folder and shift every slot by the UTC offset.
const localStamp = (d = new Date()) =>
  `${isoDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const slotLabel = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const slotMins = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };

const rawPath = (date) => path.join(RAW, `${date}.jsonl`);
const memDir = (date) => path.join(MEM, date);
const memPath = (date, slot) => path.join(memDir(date), slot.replace(':', '') + '.md');

function appendRaw(date, obj) {
  ensure();
  fs.appendFileSync(rawPath(date), JSON.stringify(obj) + '\n');
}
function readRaw(date) {
  try {
    return fs.readFileSync(rawPath(date), 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && r.ts && r.app);
  } catch { return []; }
}

// Flat `key: value` front matter, comma-separated lists. No YAML dependency, and the file
// stays something a person can open and edit without a tool.
function parseEntry(md, date, slot) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta = {};
  if (m) for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z][\w-]*):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  const list = (s) => (s || '').split(',').map((x) => x.trim()).filter((x) => x && x !== '—');
  const one = (s) => (s && s !== '—' ? s : null);
  return {
    id: slot, date, slot,
    start: meta.start || slot,
    end: meta.end || slotLabel(slotMins(slot) + SLOT_MIN),
    title: meta.title || 'Activity',
    summary: meta.summary || '',
    apps: list(meta.apps),
    sites: list(meta.sites),
    project: one(meta.project),
    activeSec: Number(meta.active || 0),
    generator: meta.generator || 'local',
    body: m ? m[2].trim() : md.trim(),
  };
}

function frontMatter(meta) {
  const order = ['start', 'end', 'title', 'summary', 'apps', 'sites', 'project', 'active', 'generator'];
  return '---\n' + order
    .map((k) => `${k}: ${meta[k] === undefined || meta[k] === '' ? '—' : String(meta[k]).replace(/\n/g, ' ')}`)
    .join('\n') + '\n---\n\n';
}

function readEntries(date) {
  let files = [];
  try { files = fs.readdirSync(memDir(date)).filter((f) => /^\d{4}\.md$/.test(f)); } catch { return []; }
  return files.sort().map((f) => {
    const slot = f.slice(0, 2) + ':' + f.slice(2, 4);
    try { return parseEntry(fs.readFileSync(path.join(memDir(date), f), 'utf8'), date, slot); } catch { return null; }
  }).filter(Boolean);
}
function writeEntry(date, slot, md) {
  fs.mkdirSync(memDir(date), { recursive: true });
  fs.writeFileSync(memPath(date, slot), md);
}
const deleteEntry = (date, slot) => { try { fs.unlinkSync(memPath(date, slot)); return true; } catch { return false; } };
const deleteDay = (date) => { try { fs.rmSync(memDir(date), { recursive: true, force: true }); return true; } catch { return false; } };
function dates() {
  try { return fs.readdirSync(MEM).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse(); } catch { return []; }
}

function search(q, days = 30) {
  const needle = String(q || '').toLowerCase().trim();
  if (!needle) return [];
  const out = [];
  for (const date of dates().slice(0, days)) {
    for (const e of readEntries(date)) {
      const hay = `${e.title} ${e.summary} ${e.body} ${e.apps.join(' ')} ${e.sites.join(' ')} ${e.project || ''}`.toLowerCase();
      if (hay.includes(needle)) out.push(e);
    }
  }
  return out;
}

/// Clear history over a window: the notes, and the raw events they were built from.
///
/// Deleting the note alone would leave the events that produced it on disk, so the next
/// rollup would write it again and "cleared" would not mean cleared.
// Derived files rebuilt from notes and the corpus. They hold real content — file paths and
// page keys — so every delete path drops them too. A cache that survives `myday clear` is a
// copy of the thing the person just asked to be rid of.
function dropDerived() {
  try { fs.rmSync(path.join(ROOT, 'cache'), { recursive: true, force: true }); } catch {}
}

function clearSince(cutoffMs) {
  let notes = 0, samples = 0;
  dropDerived();
  for (const date of dates()) {
    const kept = [];
    let touched = false;
    for (const e of readEntries(date)) {
      const at = +new Date(`${date}T${e.start}:00`);
      if (at >= cutoffMs) { deleteEntry(date, e.slot); notes++; touched = true; }
    }
    // Rewrite the raw file without the events inside the window.
    const raw = readRaw(date);
    if (raw.length) {
      const survivors = raw.filter((r) => +new Date(r.ts) < cutoffMs);
      if (survivors.length !== raw.length) {
        samples += raw.length - survivors.length;
        fs.writeFileSync(rawPath(date), survivors.map((r) => JSON.stringify(r)).join('\n') + (survivors.length ? '\n' : ''));
        touched = true;
      }
    }
    if (touched) { try { fs.rmdirSync(memDir(date)); } catch {} }   // drop the folder if empty
  }
  return { notes, samples };
}

/// Everything. Config and settings survive, because clearing history is not uninstalling.
function clearAll() {
  let notes = 0, samples = 0;
  dropDerived();
  for (const date of dates()) { notes += readEntries(date).length; deleteDay(date); }
  try {
    for (const f of fs.readdirSync(RAW).filter((f) => f.endsWith('.jsonl'))) {
      samples += readRaw(f.slice(0, 10)).length;
      fs.unlinkSync(path.join(RAW, f));
    }
  } catch {}
  return { notes, samples };
}

/// Everything a single app ever contributed.
function clearApp(app) {
  let notes = 0, samples = 0;
  dropDerived();
  for (const date of dates()) {
    for (const e of readEntries(date)) {
      if (e.apps.some((a) => a.toLowerCase() === app.toLowerCase())) { deleteEntry(date, e.slot); notes++; }
    }
    const raw = readRaw(date);
    const survivors = raw.filter((r) => (r.app || '').toLowerCase() !== app.toLowerCase());
    if (survivors.length !== raw.length) {
      samples += raw.length - survivors.length;
      fs.writeFileSync(rawPath(date), survivors.map((r) => JSON.stringify(r)).join('\n') + (survivors.length ? '\n' : ''));
    }
  }
  return { notes, samples };
}

// Anything that leaves the machine gets a line here, so "what did I send, and when" has an
// answer that does not depend on remembering.
function logEgress(kind, detail) {
  ensure();
  fs.appendFileSync(EGRESS, `${new Date().toISOString()}\t${kind}\t${detail}\n`);
}

// Raw samples expire; the summarized memory does not. A day is only pruned once it has
// been summarized, so nothing is lost that was never written down.
function pruneRaw(cfg = readConfig()) {
  const days = Number(cfg.rawRetentionDays || 0);
  if (!days) return 0;
  const cutoff = Date.now() - days * 864e5;
  let n = 0;
  let files = []; try { files = fs.readdirSync(RAW); } catch { return 0; }
  for (const f of files.filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))) {
    const date = f.slice(0, 10);
    if (+new Date(date + 'T23:59:59') >= cutoff) continue;
    if (!readEntries(date).length) continue;
    fs.unlinkSync(path.join(RAW, f)); n++;
  }
  return n;
}

module.exports = {
  dropDerived,
  ROOT, RAW, MEM, CONFIG, EGRESS, SLOT_MIN, DEFAULTS,
  ensure, readConfig, writeConfig, initialized,
  matches, allows, setRule, excludedApp, excludedSite, excludedTitle,
  clearSince, clearAll, clearApp,
  isoDate, localStamp, slotLabel, slotMins, pad,
  rawPath, appendRaw, readRaw,
  parseEntry, frontMatter, readEntries, writeEntry, deleteEntry, deleteDay, dates, search,
  logEgress, pruneRaw,
};
