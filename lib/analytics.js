'use strict';
// Views over the same captured data that the 10-minute memories are built from.
//
// The memories answer "what was I doing". These answer the questions a summary cannot:
// where the hours actually went, what you read, and what you were building. All three read
// data myday already has, so none of them cost a model call or a new permission.
//
//   apps      — time per application, context switches, the shape of the day
//   browse    — what you read, clustered by site rather than listed by visit
//   sessions  — Claude Code sessions on disk, for the audience that has them

const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('./store');
const B = require('./browsers');

const HOME = os.homedir();
const STEP = 15;       // assumed seconds per sample when the next one is missing
const GAP = 120;       // a gap longer than this means you left, so it accrues no time
const BLOCKGAP = 180;  // and a gap longer than this ends the current block

const hhmm = (d) => `${S.pad(d.getHours())}:${S.pad(d.getMinutes())}`;

// The two ways to name a running app disagree: the process name (MSTeams) and the display
// name NSWorkspace reports (Microsoft Teams). Switching capture method mid-history split
// one app into two rows, so both spellings fold to the display name before anything is
// counted. Add to this only for genuine same-app aliases, not to tidy up unrelated names.
const APP_ALIAS = {
  msteams: 'Microsoft Teams',
  'microsoft teams (work or school)': 'Microsoft Teams',
  'com.microsoft.teams2': 'Microsoft Teams',
  outlook: 'Microsoft Outlook',
  chrome: 'Google Chrome',
  code: 'Visual Studio Code',
  'vscode': 'Visual Studio Code',
};
const canonApp = (a) => APP_ALIAS[String(a || '').trim().toLowerCase()] || a;

// ---- apps ------------------------------------------------------------------------
// Time accrues sample to sample rather than by counting samples, so a pause between
// samples does not silently become time at the machine.
function appsDay(date) {
  const rows = S.readRaw(date);
  const t = (r) => new Date(r.ts).getTime() / 1000;

  const tally = (rs) => {
    const byApp = {}; let total = 0;
    for (let i = 0; i < rs.length; i++) {
      const gap = rs[i + 1] ? t(rs[i + 1]) - t(rs[i]) : null;
      const step = gap !== null && gap >= 0 && gap <= GAP ? gap : STEP;
      total += step;
      const app = canonApp(rs[i].app);
      byApp[app] = (byApp[app] || 0) + step;
    }
    return { byApp, total };
  };

  const { byApp, total } = tally(rows);
  const titles = {}, blocks = [];
  let switches = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = { ...rows[i], app: canonApp(rows[i].app) };
    const next = rows[i + 1] ? { ...rows[i + 1], app: canonApp(rows[i + 1].app) } : null;
    const gap = next ? t(next) - t(r) : null;
    const step = gap !== null && gap >= 0 && gap <= GAP ? gap : STEP;
    if (r.title) (titles[r.app] = titles[r.app] || {})[r.title] = (titles[r.app][r.title] || 0) + step;
    if (next && next.app !== r.app && gap >= 0 && gap <= GAP) switches++;
    const last = blocks[blocks.length - 1];
    if (last && last.app === r.app && t(r) - last.endT <= BLOCKGAP) {
      last.end = r.ts; last.endT = t(r) + STEP; last.secs += step;
    } else {
      blocks.push({ app: r.app, start: r.ts, end: r.ts, endT: t(r) + STEP, secs: step });
    }
  }

  const apps = Object.entries(byApp).sort((a, b) => b[1] - a[1]).map(([app, secs]) => ({
    app, secs: Math.round(secs), pct: total ? Math.round((secs / total) * 100) : 0,
    titles: Object.entries(titles[app] || {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([title, s]) => ({ title, secs: Math.round(s) })),
  }));

  const weekDays = [], weekApps = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date(date + 'T12:00:00'); d.setDate(d.getDate() - i);
    const ds = S.isoDate(d);
    const w = tally(ds === date ? rows : S.readRaw(ds));
    for (const [app, secs] of Object.entries(w.byApp)) weekApps[app] = (weekApps[app] || 0) + secs;
    weekDays.push({ date: ds, secs: Math.round(w.total) });
  }

  return {
    date, active: Math.round(total), switches,
    switchesPerHour: total ? Math.round(switches / (total / 3600)) : 0,
    first: rows.length ? rows[0].ts : null,
    last: rows.length ? rows[rows.length - 1].ts : null,
    apps,
    blocks: blocks.filter((b) => b.secs >= 30).map((b) => ({ app: b.app, start: b.start, end: b.end, secs: Math.round(b.secs) })),
    longest: blocks.length ? blocks.reduce((a, b) => (b.secs > a.secs ? b : a)) : null,
    weekDays,
    weekApps: Object.entries(weekApps).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([app, secs]) => ({ app, secs: Math.round(secs) })),
  };
}

// ---- browse ----------------------------------------------------------------------
// A raw visit list is unreadable; forty rows of the same domain say nothing. Consecutive
// visits to one site inside 25 minutes collapse into a single block, which is closer to
// how the reading actually happened.
function browseDay(date, cfg = S.readConfig()) {
  const visits = B.visits(date, cfg)
    .filter((v) => !/^(search results|sign ?in|sign ?out|signing in|signing out|working\.\.\.|redirecting|loading|new tab|untitled|just a moment.*|.*- sign ?in)$/i.test(v.title.trim()));

  const clusters = [];
  for (const v of visits) {
    const last = clusters[clusters.length - 1];
    if (last && last.host === v.host && v.ts - last.endTs < 25 * 60000) {
      last.endTs = v.ts; last.count++;
      if (!last.titles.includes(v.title) && last.titles.length < 6) last.titles.push(v.title);
    } else {
      clusters.push({ host: v.host, browser: v.browser, startTs: v.ts, endTs: v.ts, count: 1, titles: [v.title] });
    }
  }

  const byHost = {};
  for (const c of clusters) {
    const h = byHost[c.host] || (byHost[c.host] = { host: c.host, visits: 0, blocks: 0 });
    h.visits += c.count; h.blocks++;
  }

  return {
    date,
    visits: visits.length,
    hosts: Object.values(byHost).sort((a, b) => b.visits - a.visits),
    blocks: clusters.map((c) => ({
      host: c.host, browser: c.browser,
      start: hhmm(new Date(c.startTs)),
      end: c.count > 1 ? hhmm(new Date(c.endTs)) : null,
      count: c.count, titles: c.titles,
    })),
  };
}

// ---- Claude Code sessions ----------------------------------------------------------
// Optional and self-detecting: absent for anyone who does not use Claude Code, and the
// richest signal for anyone who does, since the prompt says what the work actually was.
function sessionsDay(date) {
  const base = path.join(HOME, '.claude', 'projects');
  if (!fs.existsSync(base)) return { date, available: false, sessions: [] };

  const dayStart = +new Date(date + 'T00:00:00'), dayEnd = dayStart + 864e5;
  const out = [];

  let projects = []; try { projects = fs.readdirSync(base); } catch { return { date, available: false, sessions: [] }; }
  for (const proj of projects) {
    const pdir = path.join(base, proj);
    let files = []; try { files = fs.readdirSync(pdir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const fp = path.join(pdir, f);
      let st; try { st = fs.statSync(fp); } catch { continue; }
      if (st.mtimeMs < dayStart) continue;

      let tsMin = null, tsMax = null, firstUser = '', cwd = '', turns = 0;
      try {
        for (const ln of fs.readFileSync(fp, 'utf8').split('\n')) {
          if (!ln.trim().startsWith('{')) continue;
          let e; try { e = JSON.parse(ln); } catch { continue; }
          if (e.cwd && !cwd) cwd = e.cwd;
          const ts = e.timestamp ? +new Date(e.timestamp) : 0;
          if (!ts || ts < dayStart || ts >= dayEnd) continue;
          turns++;
          if (!tsMin || ts < tsMin) tsMin = ts;
          if (!tsMax || ts > tsMax) tsMax = ts;
          if (!firstUser && e.type === 'user') {
            const c = e.message && e.message.content;
            const text = typeof c === 'string' ? c
              : Array.isArray(c) ? ((c.find((x) => x.type === 'text') || {}).text || '') : '';
            if (text && !/^\s*(caveat:|<|this session is being continued|\[request)/i.test(text)) {
              firstUser = text.replace(/\n+/g, ' ').replace(/<[^>]+>/g, '').trim().slice(0, 120);
            }
          }
        }
      } catch { continue; }
      if (!tsMin || turns < 2) continue;

      // Scheduled and headless runs are the machine working, not you working. They open with
      // an instruction sheet instead of a question: a Markdown heading, a role assignment, or
      // a skill invocation. A person typing into a terminal does none of those.
      if (/^#/.test(firstUser)) continue;
      if (/^(you are (the|a|an)\b|run the [\w-]+ skill)/i.test(firstUser)) continue;

      const project = (cwd ? path.basename(cwd) : (proj.split('-').filter(Boolean).pop() || '')) || 'general';
      out.push({
        project: project === path.basename(HOME) ? 'general' : project,
        prompt: firstUser || '(no prompt captured)', turns,
        start: hhmm(new Date(tsMin)), end: hhmm(new Date(tsMax)),
        mins: Math.max(1, Math.round((tsMax - tsMin) / 60000)),
        startTs: tsMin, endTs: tsMax,
      });
    }
  }

  out.sort((a, b) => a.startTs - b.startTs);

  // Sessions overlap constantly — several terminals, plus a long-idle one spanning the
  // afternoon. Adding their spans produced "20h 21m" on a 16-hour day, so the total is the
  // union of the intervals rather than the sum.
  const union = (spans) => {
    const merged = [];
    for (const s of [...spans].sort((a, b) => a.startTs - b.startTs)) {
      const last = merged[merged.length - 1];
      if (last && s.startTs <= last.endTs) last.endTs = Math.max(last.endTs, s.endTs);
      else merged.push({ startTs: s.startTs, endTs: s.endTs });
    }
    return Math.round(merged.reduce((a, m) => a + (m.endTs - m.startTs), 0) / 60000);
  };

  const byProject = {};
  for (const s of out) (byProject[s.project] = byProject[s.project] || []).push(s);

  return {
    date, available: true, sessions: out,
    projects: Object.entries(byProject)
      .map(([project, spans]) => ({ project, mins: union(spans), count: spans.length }))
      .sort((a, b) => b.mins - a.mins),
    totalMins: union(out),
    spanMins: out.reduce((a, s) => a + s.mins, 0),
  };
}

module.exports = { appsDay, browseDay, sessionsDay };

// ---- home: the day at a glance -------------------------------------------------------
// Everything here is computed from what was captured. No model call, so the numbers are
// reproducible and an insight can never be a plausible invention.

function homeDay(date, cfg = S.readConfig()) {
  const apps = appsDay(date);
  const browse = browseDay(date, cfg);
  const sessions = sessionsDay(date);
  const entries = S.readEntries(date);

  // Seven-day baseline, excluding today, so "busier than usual" means something.
  const prior = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(date + 'T12:00:00'); d.setDate(d.getDate() - i);
    const ds = S.isoDate(d);
    const a = appsDay(ds);
    if (a.active > 0) prior.push(a);
  }
  const avgActive = prior.length ? prior.reduce((x, a) => x + a.active, 0) / prior.length : 0;
  const avgSwitchRate = prior.length ? prior.reduce((x, a) => x + a.switchesPerHour, 0) / prior.length : 0;

  // Presence per hour, for the day-shape strip.
  const hours = Array.from({ length: 24 }, (_, h) => ({ h, secs: 0, byApp: {} }));
  const rows = S.readRaw(date);
  for (let i = 0; i < rows.length; i++) {
    const t = new Date(rows[i].ts);
    const gap = rows[i + 1] ? (new Date(rows[i + 1].ts) - t) / 1000 : cfg.intervalSec;
    const step = gap > 0 && gap <= 120 ? gap : cfg.intervalSec;
    const slot = hours[t.getHours()];
    slot.secs += step;
    const app = canonApp(rows[i].app);
    slot.byApp[app] = (slot.byApp[app] || 0) + step;
  }

  const insights = [];
  const mins = (s) => Math.round(s / 60);
  const dur = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${String(Math.round(s % 3600 / 60)).padStart(2, '0')}m` : `${Math.round(s / 60)}m`);

  if (apps.longest && apps.longest.secs >= 600) {
    insights.push({ kind: 'focus', icon: 'target',
      text: `Longest unbroken stretch: **${dur(apps.longest.secs)}** in ${apps.longest.app}, from ${apps.longest.start.slice(11, 16)}.` });
  }
  if (avgSwitchRate > 0 && apps.switchesPerHour > 0) {
    const r = apps.switchesPerHour / avgSwitchRate;
    if (r >= 1.3) insights.push({ kind: 'warn', icon: 'shuffle',
      text: `You switched apps **${apps.switchesPerHour}×/hour**, ${r.toFixed(1)}× your usual ${Math.round(avgSwitchRate)}. A choppier day than most.` });
    else if (r <= 0.75) insights.push({ kind: 'good', icon: 'shuffle',
      text: `**${apps.switchesPerHour} switches/hour** against a usual ${Math.round(avgSwitchRate)}. Less fragmented than your average day.` });
  }
  if (avgActive > 0) {
    const r = apps.active / avgActive;
    if (r >= 1.25) insights.push({ kind: 'info', icon: 'clock',
      text: `**${dur(apps.active)}** at the machine, ${Math.round((r - 1) * 100)}% above your 7-day average.` });
    else if (r <= 0.75) insights.push({ kind: 'info', icon: 'clock',
      text: `**${dur(apps.active)}** at the machine, ${Math.round((1 - r) * 100)}% below your 7-day average.` });
  }
  const busiest = hours.filter((x) => x.secs > 60).sort((a, b) => b.secs - a.secs)[0];
  if (busiest) {
    const n = Object.keys(busiest.byApp).length;
    insights.push({ kind: 'info', icon: 'sun',
      text: `Busiest hour was **${String(busiest.h).padStart(2, '0')}:00**, ${mins(busiest.secs)}m across ${n} app${n === 1 ? '' : 's'}.` });
  }
  if (apps.apps.length) {
    const top = apps.apps[0];
    if (top.pct >= 35) insights.push({ kind: 'info', icon: 'chart',
      text: `**${top.pct}%** of the day was ${top.app} alone.` });
  }
  if (sessions.available && sessions.projects.length) {
    const p = sessions.projects[0];
    insights.push({ kind: 'info', icon: 'code',
      text: `Most-worked project: **${p.project}**, ${p.mins}m across ${p.count} session${p.count === 1 ? '' : 's'}.` });
  }
  if (browse.hosts.length) {
    insights.push({ kind: 'info', icon: 'globe',
      text: `Read **${browse.visits} pages** across ${browse.hosts.length} sites — most of it ${browse.hosts[0].host}.` });
  }
  if (apps.first && apps.last) {
    const span = (new Date(apps.last) - new Date(apps.first)) / 1000;
    const density = span > 0 ? Math.round(apps.active / span * 100) : 0;
    insights.push({ kind: 'info', icon: 'span',
      text: `First keystroke ${apps.first.slice(11, 16)}, last ${apps.last.slice(11, 16)} — present for ${density}% of that ${dur(span)} span.` });
  }

  return {
    date,
    stats: {
      activeSec: apps.active,
      notes: entries.length,
      longestSec: apps.longest ? apps.longest.secs : 0,
      longestApp: apps.longest ? apps.longest.app : null,
      switches: apps.switches,
      switchesPerHour: apps.switchesPerHour,
      first: apps.first, last: apps.last,
      avgActiveSec: Math.round(avgActive),
    },
    hours: hours.map((x) => ({
      h: x.h, secs: Math.round(x.secs),
      top: Object.entries(x.byApp).sort((a, b) => b[1] - a[1])[0] || null,
    })),
    apps: apps.apps.slice(0, 7),
    blocks: apps.blocks,
    weekDays: apps.weekDays,
    sites: browse.hosts.slice(0, 6),
    projects: sessions.available ? sessions.projects.slice(0, 5) : [],
    latest: entries.slice(-3).reverse(),
    insights,
  };
}

module.exports.homeDay = homeDay;
