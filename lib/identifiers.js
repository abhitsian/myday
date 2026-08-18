'use strict';
// Identifiers — the stable names a piece of work is known by.
//
// Threading on prose failed twice. Window titles looked rich and turned out to be the worst
// possible feature: a Terminal title reads "vaibhav — ✳ Build OpenAI computer history
// feature in Day — sourcekit-lsp" for six hours, so its words bind every unrelated note in
// the day while carrying nothing that separates them. Summaries have the opposite problem:
// they paraphrase the specific thing away, so two notes about the same customer never meet.
//
// What survives both problems is an identifier: a string that is byte-identical every time
// you touch the same thing, and absent when you do not.
//
//   ~/claude-apps/day/server.js      the file, not "editing some code"
//   github.com/org/repo/pull/123     the PR, not "github.com"
//   ~/claude-apps/backscroll         the project, not "Terminal"
//
// The note's own project field already behaves this way, and it is the strongest feature in
// the existing clusterer at weight 3. That is the clue this file follows.

const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('./store');
const B = require('./browsers');

const HOME = os.homedir();
const short = (p) => p.replace(HOME, '~');

// Paths every project contains. They identify a language, not a piece of work.
const GENERIC_FILE = /(^|\/)(package\.json|package-lock\.json|README\.md|\.gitignore|tsconfig\.json|yarn\.lock|Cargo\.toml|go\.sum|requirements\.txt)$/i;

/// File paths and working directories from Claude Code, bucketed by date and slot.
///
/// Tool calls carry the file they acted on, which is the most precise statement of what was
/// being worked on that exists anywhere on the machine.
///
/// Scans the corpus ONCE for the whole range. Doing it per-day meant re-reading 1,745
/// transcripts for each of thirty days and the build simply never finished.
function claudeIdentifiersRange(dates) {
  const base = path.join(HOME, '.claude', 'projects');
  const out = {};                       // date -> slot -> Map
  if (!fs.existsSync(base) || !dates.length) return out;

  const wanted = new Set(dates);
  const sorted = [...dates].sort();
  const dayStart = +new Date(`${sorted[0]}T00:00:00`);
  const dayEnd = +new Date(`${sorted[sorted.length - 1]}T00:00:00`) + 864e5;

  let projects = [];
  try { projects = fs.readdirSync(base); } catch { return bySlot; }

  for (const proj of projects) {
    const pdir = path.join(base, proj);
    let files = [];
    try { files = fs.readdirSync(pdir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }

    for (const f of files) {
      const fp = path.join(pdir, f);
      let st; try { st = fs.statSync(fp); } catch { continue; }
      // A transcript last written before the range began cannot contain events inside it.
      if (st.mtimeMs < dayStart) continue;

      let txt = '';
      try {
        const fd = fs.openSync(fp, 'r');
        const len = Math.min(st.size, 2_000_000);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, st.size - len);
        fs.closeSync(fd);
        txt = buf.toString('utf8');
      } catch { continue; }

      let cwd = '';
      for (const ln of txt.split('\n')) {
        if (!ln.trim().startsWith('{')) continue;
        let e; try { e = JSON.parse(ln); } catch { continue; }
        if (e.cwd && !cwd) cwd = e.cwd;
        const ts = e.timestamp ? +new Date(e.timestamp) : 0;
        if (!ts || ts < dayStart || ts >= dayEnd) continue;

        const t = new Date(ts);
        const dkey = S.isoDate(t);
        if (!wanted.has(dkey)) continue;
        const slot = S.slotLabel(Math.floor((t.getHours() * 60 + t.getMinutes()) / S.SLOT_MIN) * S.SLOT_MIN);
        const bySlot = (out[dkey] = out[dkey] || {});
        const bag = (bySlot[slot] = bySlot[slot] || new Map());
        const add = (k, w) => bag.set(k, (bag.get(k) || 0) + w);

        // The project directory. Home is not a project — it is where a shell happens to open.
        if (cwd && cwd !== HOME) add('id:proj:' + short(cwd), 2);

        const content = (e.message || {}).content;
        if (!Array.isArray(content)) continue;
        for (const b of content) {
          if (!b || b.type !== 'tool_use') continue;
          const inp = b.input || {};
          const p = inp.file_path || inp.path || inp.notebook_path;
          if (!p || GENERIC_FILE.test(p)) continue;
          // Weighted above everything else: two notes touching the same file are the same
          // work, in a way that two notes sharing a word are not.
          add('id:file:' + short(p), 4);
        }
      }
    }
  }
  return out;
}

// Paths that identify a surface rather than a thing: every site has a home page and a feed.
const GENERIC_PATH = /^(|home|feed|inbox|search|results|notifications|explore|login|signin|dashboard|index)$/i;

/// URL paths from browsing, bucketed the same way.
///
/// The clusterer keys on hostname today, which is why servicenow.com behaves as a hub and
/// gets suppressed — taking the work with it. The path is the part that identifies the page.
function browsingIdentifiers(date, cfg = S.readConfig()) {
  const bySlot = {};
  let visits = [];
  try { visits = B.visits(date, cfg); } catch { return bySlot; }

  for (const v of visits) {
    let u; try { u = new URL(v.url); } catch { continue; }
    const segs = u.pathname.split('/').filter(Boolean);
    if (!segs.length || GENERIC_PATH.test(segs[0])) continue;

    const t = new Date(v.ts);
    const slot = S.slotLabel(Math.floor((t.getHours() * 60 + t.getMinutes()) / S.SLOT_MIN) * S.SLOT_MIN);
    const bag = (bySlot[slot] = bySlot[slot] || new Map());
    const key = `${u.hostname.replace(/^www\./, '')}/${segs.slice(0, 2).join('/')}`;
    bag.set('id:page:' + key, (bag.get('id:page:' + key) || 0) + 2.5);
  }
  return bySlot;
}

/// Everything identifying, for a whole range, keyed date -> slot -> Map.
function forRange(dates, cfg = S.readConfig()) {
  const out = {};
  const put = (date, slot, bag) => {
    const d = (out[date] = out[date] || {});
    const dst = (d[slot] = d[slot] || new Map());
    for (const [k, w] of bag) dst.set(k, (dst.get(k) || 0) + w);
  };

  const sources = cfg.sources || {};
  if (sources.claudeCode !== false) {
    const cc = claudeIdentifiersRange(dates);
    for (const [date, bySlot] of Object.entries(cc))
      for (const [slot, bag] of Object.entries(bySlot)) put(date, slot, bag);
  }
  if (cfg.captureBrowsers !== false) {
    // Browsing is one sqlite query per day and already cheap; no range pass needed.
    for (const date of dates)
      for (const [slot, bag] of Object.entries(browsingIdentifiers(date, cfg))) put(date, slot, bag);
  }
  return out;
}

module.exports = { forRange, claudeIdentifiersRange, browsingIdentifiers };
