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
title: <6-9 words naming the actual work, not the apps. "Debugging the webhook retry loop", not "Terminal and Chrome">
summary: <one sentence, max 20 words>
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
  if (!samples.length) return { date, written: [], skipped: ['no samples'], paused: false };

  const first = new Date(samples[0].ts);
  const firstMin = Math.floor((first.getHours() * 60 + first.getMinutes()) / S.SLOT_MIN) * S.SLOT_MIN;

  const written = [], skipped = [];
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
  return { date, written, skipped, paused: false };
}

module.exports = { rollup, buildWindow, digest, localEntry, summarize, MIN_SAMPLES };
