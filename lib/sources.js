'use strict';
// Sources — where My Day is allowed to look.
//
// The frontmost-app sampler alone tells you which window was in front. That is the floor,
// not the product. What makes a note worth reading is the other things on this machine that
// already know what you were doing: the browser knows the page, Claude Code knows the task,
// a git repo knows what shipped.
//
// Every source is separately switchable and separately detected, because "we read your
// browsing" is a different decision from "we read your terminal work", and bundling them
// into one yes/no makes the answer no.
//
// A source declares four things: whether it exists on this machine, whether it needs a
// permission, what it can see, and what it costs. The onboarding and the settings screen
// are both generated from that, so adding a source never means editing a consent screen.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const S = require('./store');

const HOME = os.homedir();
const SUPPORT = path.join(HOME, 'Library', 'Application Support');
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

const CHROMIUM_PROFILES = {
  Chrome: 'Google/Chrome/Default/History',
  Brave: 'BraveSoftware/Brave-Browser/Default/History',
  Edge: 'Microsoft Edge/Default/History',
  Arc: 'Arc/User Data/Default/History',
  Vivaldi: 'Vivaldi/Default/History',
  Chromium: 'Chromium/Default/History',
};

const SOURCES = [
  {
    id: 'apps',
    name: 'Apps and windows',
    what: 'Which application is in front, and its window title if you allow it.',
    permission: 'Accessibility, for window titles only',
    required: true,               // without this there is no timeline at all
    detect: () => ({ available: true, detail: 'built in' }),
  },
  {
    id: 'browser',
    name: 'Browsing',
    what: 'Page titles and addresses, read from the history database your browser already keeps.',
    permission: 'none — macOS does not prompt for this',
    detect: () => {
      const found = Object.entries(CHROMIUM_PROFILES)
        .filter(([, rel]) => exists(path.join(SUPPORT, rel))).map(([n]) => n);
      if (exists(path.join(HOME, 'Library/Safari/History.db'))) found.push('Safari');
      return { available: found.length > 0, detail: found.join(', ') || 'no supported browser found', found };
    },
  },
  {
    id: 'claudeCode',
    name: 'Claude Code',
    what: 'Which project you worked in, what you asked for, and a way back into the session.',
    permission: 'none — reads transcripts already on disk',
    detect: () => {
      const dir = path.join(HOME, '.claude', 'projects');
      if (!exists(dir)) return { available: false, detail: 'not installed' };
      let n = 0;
      try { for (const p of fs.readdirSync(dir)) n += fs.readdirSync(path.join(dir, p)).filter((f) => f.endsWith('.jsonl')).length; } catch {}
      return { available: n > 0, detail: `${n} session transcripts on disk` };
    },
  },
  {
    id: 'content',
    name: 'On-screen text',
    what: 'The text of the page or document in front, not just its title, so notes say what you read.',
    permission: 'Accessibility, the same grant window titles use',
    detect: () => {
      const p = require('path').join(require('os').homedir(), '.myday', 'bin', 'content');
      return { available: require('fs').existsSync(p), detail: require('fs').existsSync(p) ? 'helper built' : 'run myday build-content' };
    },
  },
  {
    id: 'git',
    name: 'Git commits',
    what: 'What you actually shipped, from repositories you already have checked out.',
    permission: 'none — reads local git logs',
    planned: true,
    detect: () => {
      // Shallow scan of the usual places rather than the whole disk.
      const roots = ['code', 'src', 'dev', 'projects', 'repos', 'work', 'claude-apps']
        .map((d) => path.join(HOME, d)).filter(exists);
      let repos = 0;
      for (const r of roots) {
        try { repos += fs.readdirSync(r).filter((d) => exists(path.join(r, d, '.git'))).length; } catch {}
      }
      return { available: repos > 0, detail: repos ? `${repos} repositories nearby` : 'no repositories found' };
    },
  },
  {
    id: 'calendar',
    name: 'Calendar',
    what: 'Which meeting a block of time belonged to, and who you met.',
    permission: 'Calendars',
    planned: true,
    detect: () => ({
      available: exists(path.join(SUPPORT, 'Calendars')),
      detail: exists(path.join(SUPPORT, 'Calendars')) ? 'local calendar store present' : 'no calendar store',
    }),
  },
];

/// Every source with its live detection and current setting folded in.
function inventory(cfg = S.readConfig()) {
  const on = cfg.sources || {};
  return SOURCES.map((s) => {
    let d;
    try { d = s.detect(); } catch { d = { available: false, detail: 'could not check' }; }
    return {
      id: s.id, name: s.name, what: s.what, permission: s.permission,
      required: !!s.required, planned: !!s.planned,
      available: d.available, detail: d.detail,
      // Available sources default on, except ones that are not built yet.
      enabled: s.required ? true
             : s.planned ? false
             : (on[s.id] !== undefined ? !!on[s.id] : d.available),
    };
  });
}

const isEnabled = (id, cfg = S.readConfig()) => {
  const s = inventory(cfg).find((x) => x.id === id);
  return !!(s && s.available && s.enabled);
};

function setEnabled(id, on) {
  const cfg = S.readConfig();
  const sources = { ...(cfg.sources || {}), [id]: !!on };
  S.writeConfig({ sources });
  // captureBrowsers predates this registry and is still read by the rollup and friction
  // paths; keep the two in step rather than leaving a second switch that disagrees.
  if (id === 'browser') S.writeConfig({ captureBrowsers: !!on });
  return inventory();
}

module.exports = { SOURCES, inventory, isEnabled, setEnabled, CHROMIUM_PROFILES };
