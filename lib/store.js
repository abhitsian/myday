'use strict';
// Paths, config, and the memory files. Everything backscroll knows lives under ~/.backscroll.

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.env.BACKSCROLL_HOME || path.join(os.homedir(), '.backscroll');
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
  captureTitles: true,            // needs the helper + Accessibility; app names work regardless
  captureBrowsers: true,
  browsers: ['Chrome', 'Brave', 'Edge', 'Arc', 'Vivaldi'],
  rawRetentionDays: 14,
  intervalSec: 15,
  idleMaxSec: 120,
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
const excludedApp = (app, c) => (c.excludeApps || []).some((p) => matches(app, p));
const excludedSite = (u, c) => (c.excludeSites || []).some((p) => matches(u, p));
const excludedTitle = (t, c) => (c.excludeTitlePatterns || []).some((p) => matches(t, p));

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
  ROOT, RAW, MEM, CONFIG, EGRESS, SLOT_MIN, DEFAULTS,
  ensure, readConfig, writeConfig, initialized,
  matches, excludedApp, excludedSite, excludedTitle,
  isoDate, localStamp, slotLabel, slotMins, pad,
  rawPath, appendRaw, readRaw,
  parseEntry, frontMatter, readEntries, writeEntry, deleteEntry, deleteDay, dates, search,
  logEgress, pruneRaw,
};
