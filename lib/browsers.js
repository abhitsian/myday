'use strict';
// Page titles and URLs, read from each browser's own history database.
//
// This is what lets backscroll say "you were reading the Stripe webhook docs" instead of
// "you were in Chrome" without ever looking at the screen or asking for Accessibility.
// The DB is copied before reading: the live file is locked while the browser runs, and a
// copy also guarantees we cannot write to it.
//
// Chromium timestamps are microseconds since 1601-01-01. Safari's are seconds since
// 2001-01-01 and its DB needs Full Disk Access, so it is opt-in and fails quietly.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const SUPPORT = path.join(HOME, 'Library', 'Application Support');

const CHROMIUM = {
  Chrome: path.join(SUPPORT, 'Google/Chrome/Default/History'),
  Brave: path.join(SUPPORT, 'BraveSoftware/Brave-Browser/Default/History'),
  Edge: path.join(SUPPORT, 'Microsoft Edge/Default/History'),
  Arc: path.join(SUPPORT, 'Arc/User Data/Default/History'),
  Vivaldi: path.join(SUPPORT, 'Vivaldi/Default/History'),
  Chromium: path.join(SUPPORT, 'Chromium/Default/History'),
};
const SAFARI = path.join(HOME, 'Library/Safari/History.db');

const CHROME_EPOCH_OFFSET = 11644473600; // seconds between 1601-01-01 and 1970-01-01
const SAFARI_EPOCH_OFFSET = 978307200;   // seconds between 2001-01-01 and 1970-01-01

function query(dbPath, sql) {
  if (!fs.existsSync(dbPath)) return [];
  const tmp = path.join(os.tmpdir(), `backscroll-${path.basename(path.dirname(dbPath))}-${process.pid}.db`);
  try {
    fs.copyFileSync(dbPath, tmp);
    const out = execFileSync('sqlite3', ['-json', '-readonly', tmp, sql], {
      encoding: 'utf8', timeout: 20000, maxBuffer: 3e7,
    }).trim();
    return out ? JSON.parse(out) : [];
  } catch {
    return [];
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// Visits on `date`, as { ts (ms), host, url, title, browser }.
function visits(date, cfg) {
  if (!cfg.captureBrowsers) return [];
  const startMs = +new Date(`${date}T00:00:00`);
  const endMs = startMs + 864e5;
  const rows = [];

  for (const name of cfg.browsers || []) {
    const db = CHROMIUM[name];
    if (!db) continue;
    const lo = Math.round((startMs / 1000 + CHROME_EPOCH_OFFSET) * 1e6);
    const hi = Math.round((endMs / 1000 + CHROME_EPOCH_OFFSET) * 1e6);
    const sql =
      `SELECT u.url AS url, u.title AS title, v.visit_time AS t ` +
      `FROM visits v JOIN urls u ON u.id = v.url ` +
      `WHERE v.visit_time >= ${lo} AND v.visit_time < ${hi} ORDER BY v.visit_time;`;
    for (const r of query(db, sql)) {
      rows.push({ ts: (Number(r.t) / 1e6 - CHROME_EPOCH_OFFSET) * 1000, url: r.url || '', title: (r.title || '').trim(), browser: name });
    }
  }

  if ((cfg.browsers || []).includes('Safari')) {
    const lo = startMs / 1000 - SAFARI_EPOCH_OFFSET, hi = endMs / 1000 - SAFARI_EPOCH_OFFSET;
    const sql =
      `SELECT i.url AS url, v.title AS title, v.visit_time AS t ` +
      `FROM history_visits v JOIN history_items i ON i.id = v.history_item ` +
      `WHERE v.visit_time >= ${lo} AND v.visit_time < ${hi} ORDER BY v.visit_time;`;
    for (const r of query(SAFARI, sql)) {
      rows.push({ ts: (Number(r.t) + SAFARI_EPOCH_OFFSET) * 1000, url: r.url || '', title: (r.title || '').trim(), browser: 'Safari' });
    }
  }

  const S = require('./store');
  return rows
    .map((r) => {
      let host = '';
      try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch {}
      return { ...r, host };
    })
    .filter((r) => r.host && r.title)
    .filter((r) => !S.excludedSite(r.url, cfg) && !S.excludedSite(r.host, cfg))
    .filter((r) => !S.excludedTitle(r.title, cfg))
    .sort((a, b) => a.ts - b.ts);
}

function installed() {
  const found = [];
  for (const [name, db] of Object.entries(CHROMIUM)) if (fs.existsSync(db)) found.push(name);
  if (fs.existsSync(SAFARI)) found.push('Safari');
  return found;
}

module.exports = { visits, installed, CHROMIUM, SAFARI };
