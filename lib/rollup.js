'use strict';
// Every 10 minutes, the raw samples for one window become a memory file.
//
// Three summarizers, chosen by config, defaulting to the one that sends nothing anywhere:
//   local       — a deterministic digest. No network, no model, no cost.
//   claude-cli  — shells out to the `claude` CLI if the user has Claude Code.
//   api         — Anthropic Messages API with ANTHROPIC_API_KEY.
// The last two write a line to egress.log every time, because "did this leave my machine"
// should be answerable from a file rather than from memory.

const { execFileSync } = require('child_process');
const https = require('https');
const path = require('path');
const fs = require('fs');
const S = require('./store');
const B = require('./browsers');

const MIN_SAMPLES = 3;
const NOISE_TITLE = /^(search results|sign ?in|sign ?out|signing in|signing out|working\.\.\.|redirecting|loading|new tab|untitled|just a moment.*|.*- sign ?in|home)$/i;

const mmss = (s) => (s >= 60 ? `${Math.round(s / 60)}m` : `${s}s`);

// ---- assemble one window ----
function buildWindow(date, slot, cfg = S.readConfig()) {
  const startMin = S.slotMins(slot), endMin = startMin + S.SLOT_MIN;
  const startMs = +new Date(`${date}T${S.slotLabel(startMin)}:00`);
  const endMs = startMs + S.SLOT_MIN * 60000;

  const rows = S.readRaw(date).filter((r) => {
    const t = +new Date(r.ts);
    return t >= startMs && t < endMs && !S.excludedApp(r.app, cfg);
  });

  const byApp = {}, titles = {};
  let switches = 0;
  for (let i = 0; i < rows.length; i++) {
    const gap = rows[i + 1] ? (+new Date(rows[i + 1].ts) - +new Date(rows[i].ts)) / 1000 : cfg.intervalSec;
    const step = gap > 0 && gap <= 120 ? gap : cfg.intervalSec;
    byApp[rows[i].app] = (byApp[rows[i].app] || 0) + step;
    if (rows[i].title) (titles[rows[i].app] = titles[rows[i].app] || new Set()).add(rows[i].title);
    if (rows[i + 1] && rows[i + 1].app !== rows[i].app) switches++;
  }
  const apps = Object.entries(byApp).sort((a, b) => b[1] - a[1])
    .map(([app, secs]) => ({ app, secs: Math.round(secs), titles: [...(titles[app] || [])].slice(0, 3) }));

  const seen = new Set();
  const sites = B.visits(date, cfg)
    .filter((v) => v.ts >= startMs && v.ts < endMs)
    .filter((v) => { const k = v.host + '|' + v.title; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 12);

  return {
    date, slot,
    start: S.slotLabel(startMin), end: S.slotLabel(endMin),
    samples: rows.length,
    activeSec: Math.round(Object.values(byApp).reduce((a, b) => a + b, 0)),
    apps, switches, sites,
  };
}

function digest(w) {
  const L = [];
  L.push(`Window: ${w.date} ${w.start}–${w.end} · ${mmss(w.activeSec)} at the machine · ${w.switches} app switches`);
  L.push(`Apps: ${w.apps.map((a) => `${a.app} ${mmss(a.secs)}${a.titles.length ? ` [${a.titles.join(' | ')}]` : ''}`).join(', ') || 'none'}`);
  if (w.sites.length) L.push(`Pages visited:\n${w.sites.map((s) => `  - ${s.host} — ${s.title}`).join('\n')}`);
  return L.join('\n');
}

// ---- summarizers ----
function localEntry(w) {
  const top = w.apps[0], site = w.sites[0];
  const title = site ? `${site.host} — ${site.title}`.slice(0, 70)
    : top && top.titles[0] ? `${top.app} — ${top.titles[0]}`.slice(0, 70)
    : top ? top.app : 'At the machine';
  const lines = [
    `- ${mmss(w.activeSec)} active, ${w.switches} app switch${w.switches === 1 ? '' : 'es'}.`,
    ...w.apps.slice(0, 5).map((a) => `- ${a.app} — ${mmss(a.secs)}${a.titles.length ? ` (${a.titles[0]})` : ''}`),
    ...w.sites.slice(0, 5).map((s) => `- Visited ${s.host} — ${s.title}`),
  ];
  return S.frontMatter({
    start: w.start, end: w.end, title,
    summary: `${w.apps.slice(0, 3).map((a) => a.app).join(', ') || 'idle'} · ${mmss(w.activeSec)} active`,
    apps: w.apps.map((a) => a.app).join(', '),
    sites: [...new Set(w.sites.map((s) => s.host))].join(', '),
    project: '—',
    active: w.activeSec, generator: 'local',
  }) + lines.join('\n') + '\n';
}

const PROMPT = (w) => `You write one entry in a personal computer-history log. The user will search it
later with questions like "what was I debugging yesterday" or "where did I leave off".
Write it so those are answerable.

Raw capture for this 10-minute window:
${digest(w)}

Output ONLY a Markdown file in exactly this shape, no fences, no preamble:

---
start: ${w.start}
end: ${w.end}
title: <4-8 words naming the piece of work, as a thing done. "Tracing the webhook retry loop", "Prepared the launch update". Never the app names.>
summary: <one sentence addressed to the reader, starting with "You", max 24 words. "You read Stripe's idempotency docs, then edited retry.ts." Say what they did, not which apps were open.>
apps: <comma-separated app names copied VERBATIM from the capture — these are aggregated across days and a renamed app splits the total>
sites: <comma-separated hostnames, or —>
project: <code project or document name if identifiable, else —>
active: ${w.activeSec}
generator: MODEL
---

<2-5 bullets. Each names something specific and recoverable: the file, the page, the error,
the question being worked on. Prefer the thing over the tool. If the window is plainly
low-signal (scrolling a feed, idling in an inbox) say that in one bullet and stop. Never
invent detail the capture does not support.>`;

function viaClaudeCli(w, cfg) {
  const bin = ['claude', path.join(require('os').homedir(), '.local/bin/claude')].find((b) => {
    try { execFileSync('which', [b], { stdio: 'ignore' }); return true; } catch { return b !== 'claude' && fs.existsSync(b); }
  });
  if (!bin) throw new Error('claude CLI not found');
  S.logEgress('rollup:claude-cli', `${w.date} ${w.start} apps=${w.apps.length} sites=${w.sites.length}`);
  return execFileSync(bin, ['-p', PROMPT(w)], { encoding: 'utf8', timeout: 90000, maxBuffer: 4 << 20 });
}

function viaApi(w, cfg) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  S.logEgress('rollup:api', `${w.date} ${w.start} model=${cfg.model} apps=${w.apps.length} sites=${w.sites.length}`);
  const payload = JSON.stringify({
    model: cfg.model,
    max_tokens: 700,
    messages: [{ role: 'user', content: PROMPT(w) }],
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-length': Buffer.byteLength(payload),
      },
      timeout: 60000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j.error) return reject(new Error(j.error.message || 'api error'));
          resolve((j.content || []).map((c) => c.text || '').join(''));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.write(payload);
    req.end();
  });
}

async function summarize(w, cfg) {
  if (cfg.summarizer === 'local') return localEntry(w);
  try {
    const raw = cfg.summarizer === 'api' ? await viaApi(w, cfg) : viaClaudeCli(w, cfg);
    const md = String(raw).trim().replace(/^```(?:markdown|md)?\n?/, '').replace(/\n?```$/, '').trim();
    if (!md.startsWith('---') || !S.parseEntry(md, w.date, w.slot).title) throw new Error('unparseable');
    return md.replace('generator: MODEL', `generator: ${cfg.summarizer}`) + (md.endsWith('\n') ? '' : '\n');
  } catch (e) {
    // A hole in the timeline reads as "you were not there", which would be a lie. Always
    // write something, and record why the model path did not run.
    return localEntry(w).replace('generator: local', `generator: local (${String(e.message).slice(0, 40)})`);
  }
}

// ---- the pass ----
async function rollup({ date, force = false, limit = 24, log = () => {} } = {}) {
  const cfg = S.readConfig();
  date = date || S.isoDate();
  if (cfg.paused && !force) return { paused: true, written: [], skipped: [] };

  const now = new Date();
  const isToday = S.isoDate(now) === date;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const lastComplete = isToday ? Math.floor(nowMin / S.SLOT_MIN) * S.SLOT_MIN : 24 * 60;

  const have = new Set(S.readEntries(date).map((e) => e.slot));
  const samples = S.readRaw(date);
  if (!samples.length) return { date, written: [], skipped: [], paused: false,
    reason: 'no samples recorded for this day — is the daemon running? try `myday status`' };

  const first = new Date(samples[0].ts);
  const firstMin = Math.floor((first.getHours() * 60 + first.getMinutes()) / S.SLOT_MIN) * S.SLOT_MIN;

  const written = [], skipped = [];
  // A slot is only summarized once it has fully elapsed, so on a fresh install there is
  // nothing to write for up to ten minutes. Saying "0 written" without saying why reads as
  // broken, so the caller gets the reason back.
  if (firstMin + S.SLOT_MIN > lastComplete) {
    const waitMin = Math.max(1, (firstMin + S.SLOT_MIN) - (now.getHours() * 60 + now.getMinutes()));
    return { date, written, skipped, paused: false,
      reason: `the current ${S.SLOT_MIN}-minute window is still open — first memory in about ${waitMin}m` };
  }
  for (let m = firstMin; m + S.SLOT_MIN <= lastComplete && written.length < limit; m += S.SLOT_MIN) {
    const slot = S.slotLabel(m);
    if (have.has(slot) && !force) continue;
    const w = buildWindow(date, slot, cfg);
    if (w.samples < MIN_SAMPLES) { skipped.push(slot); continue; }
    log(`${date} ${slot} — ${w.samples} samples, ${w.apps.length} apps`);
    S.writeEntry(date, slot, await summarize(w, cfg));
    written.push(slot);
  }
  S.pruneRaw(cfg);
  return { date, written, skipped, paused: false,
    reason: written.length ? null
      : skipped.length ? `every window was below the ${MIN_SAMPLES}-sample floor (you were away)`
      : 'nothing new to summarize' };
}

// Reconstruct notes for days that predate the install, from browsing alone.
//
// This is the cold-start fix. Threads need two or three weeks, friction needs two or three
// weeks, and "against your usual" needs a baseline — so a new install is unimpressive at
// exactly the moment someone decides whether to keep it. The browser has already been
// keeping a history for months, and reading it costs no permission.
//
// These notes carry `source: browser` and no app or window data, because they are
// reconstructed rather than observed and the file should say so.
async function backfillFromBrowser({ days = 60, log = () => {}, limitPerDay = 40 } = {}) {
  const cfg = S.readConfig();
  const written = [];
  const skipped = [];

  for (let i = 1; i <= days; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const date = S.isoDate(d);
    if (S.readRaw(date).length) { skipped.push(date); continue; }  // real capture wins
    const have = new Set(S.readEntries(date).map((e) => e.slot));

    const visits = B.visits(date, cfg);
    if (!visits.length) continue;

    // Group visits into the same ten-minute grid the live rollup uses, so a backfilled day
    // and a recorded day are the same shape.
    const bySlot = {};
    for (const v of visits) {
      const t = new Date(v.ts);
      const m = Math.floor((t.getHours() * 60 + t.getMinutes()) / S.SLOT_MIN) * S.SLOT_MIN;
      (bySlot[S.slotLabel(m)] = bySlot[S.slotLabel(m)] || []).push(v);
    }

    let n = 0;
    for (const [slot, vs] of Object.entries(bySlot).sort()) {
      if (have.has(slot) || n >= limitPerDay) continue;
      const seen = new Set();
      const sites = vs
        // Auth interstitials and background-tab refreshes are not reading. Without this the
        // first thing a new user saw was a wall of notes titled "Sign out" at 3am.
        .filter((v) => !NOISE_TITLE.test((v.title || '').trim()))
        .filter((v) => { const k = v.host + '|' + v.title;
          if (seen.has(k)) return false; seen.add(k); return true; })
        .slice(0, 12);
      // Two distinct pages, not two visits: a redirect chain is one thing happening.
      if (sites.length < 2) continue;

      const w = {
        date, slot,
        start: slot, end: S.slotLabel(S.slotMins(slot) + S.SLOT_MIN),
        samples: sites.length,
        // No app samples exist for these days, so time is unknown rather than zero.
        activeSec: 0,
        apps: [], switches: 0, sites,
      };
      const md = (await summarize(w, cfg))
        .replace(/^generator: /m, 'source: browser\ngenerator: ');
      S.writeEntry(date, slot, md);
      written.push(`${date} ${slot}`); n++;
    }
    if (n) log(`${date} — ${n} notes reconstructed from browsing`);
  }
  return { written, skipped };
}

module.exports = { rollup, buildWindow, digest, localEntry, summarize, backfillFromBrowser, MIN_SAMPLES };
