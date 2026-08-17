'use strict';
// The sampler. Records which app is in front, and its window title when that is available,
// every intervalSec while the user is actually at the machine.
//
// Three tiers, and the tool is useful at every one:
//   1. no permission at all  — `lsappinfo front` gives the app name. Nothing to grant.
//   2. + browser history     — page titles and URLs, read from the browser's own DB.
//   3. + the helper binary   — window titles, once Accessibility is granted to ONE binary.
//
// Starting at tier 1 is the point. A memory tool that demands accessibility before it shows
// you anything has to be trusted on a promise; this one earns it on tier 1 and 2 output.

const { execFileSync, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const S = require('./store');

// The compiled helper lives in the user's data directory, NOT inside the installed package.
// node_modules is replaced wholesale on every `npm update`, which would delete the binary and
// silently stop title capture; worse, macOS would keep an Accessibility entry pointing at that
// path, so the grant looks present in System Settings while doing nothing.
const HELPER = path.join(S.ROOT, 'bin', 'frontwindow');
const HELPER_SRC = path.join(__dirname, '..', 'helper', 'frontwindow.swift');

// Tier 3. Prints "app\ttitle"; exit 2 means it ran but has no Accessibility grant, in which
// case the title is empty and the app name is still good.
function viaHelper() {
  try {
    const out = execFileSync(HELPER, { encoding: 'utf8', timeout: 3000 }).trim();
    const i = out.indexOf('\t');
    return i === -1 ? { app: out, title: '' } : { app: out.slice(0, i), title: out.slice(i + 1) };
  } catch (e) {
    // exit 2 still produced usable stdout
    const out = (e.stdout || '').toString().trim();
    if (out) { const i = out.indexOf('\t'); return i === -1 ? { app: out, title: '' } : { app: out.slice(0, i), title: out.slice(i + 1) }; }
    return null;
  }
}

// Tier 1. LaunchServices will name the front app for anyone who asks. No TCC prompt, no
// AppleScript, works on a machine where the user has granted nothing.
function viaLaunchServices() {
  try {
    const asn = execSync('lsappinfo front', { encoding: 'utf8', timeout: 3000 }).trim();
    if (!asn) return null;
    const info = execSync(`lsappinfo info -only name ${JSON.stringify(asn)}`, { encoding: 'utf8', timeout: 3000 });
    const m = info.match(/"LSDisplayName"\s*=\s*"(.*)"/);
    return m ? { app: m[1], title: '' } : null;
  } catch { return null; }
}

function frontmost(cfg) {
  if (cfg.captureTitles && fs.existsSync(HELPER)) {
    const r = viaHelper();
    if (r && r.app) return r;
  }
  return viaLaunchServices();
}

function idleSeconds() {
  try {
    const out = execSync("ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print int($NF/1000000000); exit}'", { encoding: 'utf8', timeout: 3000 });
    const n = parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

// One sample. Exclusions are applied here rather than at read time, so an excluded app is
// never on disk in the first place and there is no later filtering step that can be wrong.
function sampleOnce() {
  const cfg = S.readConfig();
  if (cfg.paused) return { skipped: 'paused' };

  const idle = idleSeconds();
  if (idle === null || idle >= cfg.idleMaxSec) return { skipped: 'away' };

  const f = frontmost(cfg);
  if (!f || !f.app) return { skipped: 'no-frontmost' };
  if (S.excludedApp(f.app, cfg)) return { skipped: 'excluded-app' };

  const title = S.excludedTitle(f.title, cfg) ? '' : (f.title || '');
  const now = new Date();
  S.appendRaw(S.isoDate(now), {
    ts: S.localStamp(now),
    app: f.app,
    title,
    idle,
  });
  return { app: f.app, title, idle };
}

function loop() {
  const tick = () => {
    try { sampleOnce(); } catch (e) { process.stderr.write('[myday] sample error: ' + e.message + '\n'); }
    setTimeout(tick, (S.readConfig().intervalSec || 15) * 1000);
  };
  tick();
}

// What the user is actually being asked for, printed before anything is captured.
//
// Trust is per-process, and that distinction is the whole point here. Run from a terminal,
// the helper inherits the terminal's Accessibility grant and reports trusted. Run from the
// launchd daemon it inherits nothing. Asking the question in the CLI therefore answers for
// the wrong process, so the honest signal is what the daemon has actually been writing.
function capabilities() {
  const cfg = S.readConfig();
  const helper = fs.existsSync(HELPER);
  let cliTrusted = false;
  if (helper) {
    try { execFileSync(HELPER, ['--check'], { encoding: 'utf8', timeout: 3000 }); cliTrusted = true; }
    catch { cliTrusted = false; }
  }

  // Evidence from the daemon itself: of the last 40 samples, how many carried a title.
  const recent = S.readRaw(S.isoDate()).slice(-40);
  const titled = recent.filter((r) => r.title).length;

  return {
    appNames: !!viaLaunchServices(),
    helperBuilt: helper,
    cliTrusted,
    recentSamples: recent.length,
    titledSamples: titled,
    // Only claim titles work once the daemon has proven it, and never on the CLI's say-so.
    windowTitles: helper && cfg.captureTitles && recent.length >= 4 && titled > 0,
    idle: idleSeconds() !== null,
  };
}

module.exports = { sampleOnce, loop, frontmost, idleSeconds, capabilities, HELPER, HELPER_SRC };
