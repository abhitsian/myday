'use strict';
// Real application icons, pulled from the app bundles already on this Mac.
//
// A row of actual Chrome / Slack / VS Code marks tells you what a block of work was at a
// glance, in a way a row of text chips never does. Nothing is downloaded: the icon is read
// out of the installed bundle and cached as a PNG under ~/.myday/icons.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const S = require('./store');

const CACHE = path.join(S.ROOT, 'icons');
const SEARCH = [
  '/Applications',
  '/Applications/Utilities',
  '/System/Applications',
  '/System/Applications/Utilities',
  path.join(os.homedir(), 'Applications'),
];

// The sampler records the display name, which usually but not always matches the bundle
// name on disk. These are the mismatches worth carrying.
const BUNDLE_ALIAS = {
  'Microsoft Teams': ['Microsoft Teams', 'Microsoft Teams (work or school)', 'MSTeams'],
  'MSTeams': ['Microsoft Teams', 'MSTeams'],
  'Visual Studio Code': ['Visual Studio Code', 'Code'],
  'Code': ['Visual Studio Code', 'Code'],
  'Google Chrome': ['Google Chrome'],
  'System Settings': ['System Settings', 'System Preferences'],
  'Finder': ['Finder'],
};

function bundleFor(appName) {
  const names = BUNDLE_ALIAS[appName] || [appName];
  for (const n of names) {
    for (const d of SEARCH) {
      const p = path.join(d, `${n}.app`);
      if (fs.existsSync(p)) return p;
    }
  }
  // Finder and a few system apps live outside the usual directories.
  for (const n of names) {
    try {
      const out = execFileSync('mdfind', ['-name', `${n}.app`], { encoding: 'utf8', timeout: 6000 })
        .split('\n').map((l) => l.trim()).filter((l) => l.endsWith(`${n}.app`));
      if (out.length) return out[0];
    } catch {}
  }
  return null;
}

/// Path to a cached 64px PNG for an app, or null if the app cannot be found. Extraction
/// runs once per app; after that it is a file read.
function iconFor(appName) {
  if (!appName) return null;
  const safe = appName.replace(/[^a-zA-Z0-9 _-]/g, '').trim();
  if (!safe) return null;
  const out = path.join(CACHE, `${safe}.png`);
  if (fs.existsSync(out)) return fs.statSync(out).size > 0 ? out : null;

  fs.mkdirSync(CACHE, { recursive: true });
  const bundle = bundleFor(appName);
  if (!bundle) { fs.writeFileSync(out, ''); return null; }   // negative-cache the miss

  let icnsName = 'AppIcon';
  try {
    icnsName = execFileSync('plutil', ['-extract', 'CFBundleIconFile', 'raw', path.join(bundle, 'Contents/Info.plist')],
      { encoding: 'utf8', timeout: 5000 }).trim().replace(/\.icns$/, '');
  } catch {}

  const res = path.join(bundle, 'Contents', 'Resources');
  let icns = path.join(res, `${icnsName}.icns`);
  if (!fs.existsSync(icns)) {
    // Fall back to whatever .icns the bundle does ship.
    try { const f = fs.readdirSync(res).find((x) => x.endsWith('.icns')); if (f) icns = path.join(res, f); } catch {}
  }
  if (!fs.existsSync(icns)) { fs.writeFileSync(out, ''); return null; }

  try {
    execFileSync('sips', ['-s', 'format', 'png', '-Z', '64', icns, '--out', out],
      { stdio: 'ignore', timeout: 15000 });
    return fs.existsSync(out) && fs.statSync(out).size > 0 ? out : null;
  } catch {
    fs.writeFileSync(out, '');
    return null;
  }
}

module.exports = { iconFor, bundleFor, CACHE };
