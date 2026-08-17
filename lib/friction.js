'use strict';
// Friction — the small recurring costs a day hides from you.
//
// Not "you were unproductive". Every finding here is a specific, repeated, fixable thing
// with the evidence attached: how many times, across how many days, and what to do about it.
// Everything is counted from data already captured, so nothing can be invented — if a
// pattern is not in the record it does not get reported.
//
// Time costs are labelled estimates because they are. A re-login is timed at 30 seconds
// because that is roughly what an SSO round trip takes, not because it was measured.

const S = require('./store');
const B = require('./browsers');

const AUTH_RX = /\/(login|signin|sign-in|sso|oauth2?|auth|saml|callback|idps?|authorize|agentless)/i;
const HOMEPAGE_RX = /^[^/]+\/?$/;   // bare host, i.e. someone's home page

const pad = (n) => String(n).padStart(2, '0');
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function lastNDates(days) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    out.push(dateKey(d));
  }
  return out;
}

function allVisits(days, cfg) {
  // One range query rather than one per day: the per-day helper copies the whole history
  // database each time, and twenty-one copies took long enough to look like a hang.
  const end = new Date(); end.setHours(23, 59, 59, 999);
  const start = new Date(); start.setDate(start.getDate() - (days - 1)); start.setHours(0, 0, 0, 0);
  return B.visitsBetween(+start, +end, cfg)
    .map((v) => ({ ...v, date: dateKey(new Date(v.ts)) }))
    .sort((a, b) => a.ts - b.ts);
}

function pathKey(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const seg = u.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
    return seg ? `${host}/${seg}` : host;
  } catch { return null; }
}

// ---- 1. re-authentication -------------------------------------------------------------
// A login flow you walk through repeatedly is a session-length or SSO setting, not a habit.
function authLoops(visits, days) {
  // One sign-in is a burst of redirects: okta → oauth2 → idps → callback, all inside a few
  // seconds. Counting hops made a single login look like four problems and inflated okta to
  // 286. Visits to the same host inside five minutes collapse into one login event.
  const byHost = {};
  for (const v of visits) {
    let u; try { u = new URL(v.url); } catch { continue; }
    if (!AUTH_RX.test(u.pathname)) continue;
    const host = u.hostname.replace(/^www\./, '');
    const h = byHost[host] || (byHost[host] = { host, events: 0, lastTs: -Infinity, days: new Set() });
    if (v.ts - h.lastTs > 5 * 60000) { h.events++; h.days.add(v.date); }
    h.lastTs = v.ts;
  }
  const perWeek = (n) => n / (days / 7);
  return Object.values(byHost)
    // Roughly daily or worse. Signing in weekly is normal and not worth a finding.
    .filter((h) => h.days.size >= 4 && perWeek(h.events) >= 3)
    .sort((a, b) => b.events - a.events)
    .slice(0, 5)
    .map((h) => ({
      kind: 'auth',
      title: `Signing in to ${h.host} again`,
      detail: `${h.events} separate sign-ins over ${days} days, on ${h.days.size} different days.`,
      evidence: `${h.events} login events (redirect bursts collapsed)`,
      estMinPerWeek: Math.round(perWeek(h.events) * 0.5),
      fix: `About ${Math.round(perWeek(h.events))}× a week. Worth asking whoever runs it for a longer session, since the timeout is the cause, not you.`,
    }));
}

// ---- 2. searches you repeat ------------------------------------------------------------
// The same query typed on different days means the answer never got saved anywhere.
function repeatSearches(visits) {
  const norm = (q) => q.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const byQ = {};
  for (const v of visits) {
    let u; try { u = new URL(v.url); } catch { continue; }
    const q = u.searchParams.get('q') || u.searchParams.get('query');
    if (!q || !/google\.|bing\.|duckduckgo\./.test(u.hostname)) continue;
    const k = norm(q);
    if (k.length < 6) continue;
    const e = byQ[k] || (byQ[k] = { q, hits: 0, days: new Set() });
    e.hits++; e.days.add(v.date);
  }
  return Object.values(byQ)
    .filter((e) => e.days.size >= 4)
    .sort((a, b) => b.days.size - a.days.size || b.hits - a.hits)
    .slice(0, 6)
    .map((e) => ({
      kind: 'search',
      title: `Searched "${e.q}" again`,
      detail: `${e.hits} times across ${e.days.size} days.`,
      evidence: `repeated web search`,
      estMinPerWeek: Math.round(e.hits / 3),
      fix: `Whatever you land on for this, keep the link — you have looked for it ${e.days.size} separate days.`,
    }));
}

// ---- 3. pages you keep coming back to ---------------------------------------------------
// A page opened most days that is not somebody's home page is a bookmark you never made.
// Endpoints whose URL is the same for every different thing you looked at. Keying on the
// path collapsed every Google search into one row titled with whatever was searched first —
// 651 hits on a rowing-machine query. They are excluded rather than mis-titled.
const QUERY_ENDPOINT_RX = /\/(search|results|watch|feed|notifications|explore|home|inbox|messages)\b/i;

function boomerangPages(visits) {
  const byPath = {};
  for (const v of visits) {
    const k = pathKey(v.url);
    if (!k || HOMEPAGE_RX.test(k)) continue;
    let u; try { u = new URL(v.url); } catch { continue; }
    if (AUTH_RX.test(u.pathname)) continue;
    if (QUERY_ENDPOINT_RX.test(u.pathname)) continue;
    if (u.search && /[?&](q|query|search)=/.test(u.search)) continue;
    const e = byPath[k] || (byPath[k] = { key: k, hits: 0, days: new Set(), titles: {} });
    e.hits++; e.days.add(v.date);
    // Most frequent title, not the longest — the longest is whatever happened to be verbose.
    if (v.title) e.titles[v.title] = (e.titles[v.title] || 0) + 1;
  }
  return Object.values(byPath)
    .filter((e) => e.days.size >= 6)
    .sort((a, b) => b.days.size - a.days.size || b.hits - a.hits)
    .slice(0, 5)
    .map((e) => {
      const title = Object.entries(e.titles).sort((a, b) => b[1] - a[1])[0];
      return {
        kind: 'boomerang',
        title: (title ? title[0] : e.key).slice(0, 80),
        detail: `Opened on ${e.days.size} separate days, ${e.hits} times in total.`,
        evidence: e.key,
        estMinPerWeek: 0,
        fix: `You navigate here most days. Worth a pinned tab or a bookmark on the bar.`,
      };
    });
}

// ---- 4. two apps you bounce between ------------------------------------------------------
// A→B→A inside a couple of minutes, repeatedly. Only counted when one side is a comms app.
// Editor ⇄ terminal ⇄ browser is the shape of the work itself, not a problem to solve, and
// flagging it as friction told a developer their job was the bug.
const COMMS = /^(msteams|microsoft teams|slack|outlook|microsoft outlook|mail|messages|whatsapp|zoom|zoom\.us|discord|telegram)$/i;

function appPingPong(days) {
  const pairs = {};
  for (const date of lastNDates(days)) {
    const rows = S.readRaw(date);
    const seq = [];
    for (const r of rows) {
      const t = +new Date(r.ts);
      if (!seq.length || seq[seq.length - 1].app !== r.app) seq.push({ app: r.app, t });
    }
    for (let i = 0; i + 2 < seq.length; i++) {
      const [a, b, c] = [seq[i], seq[i + 1], seq[i + 2]];
      if (a.app !== c.app || a.app === b.app) continue;
      if (c.t - a.t > 120000) continue;               // the whole bounce inside two minutes
      if (!COMMS.test(a.app) && !COMMS.test(b.app)) continue;
      const k = [a.app, b.app].sort().join(' ⇄ ');   // A⇄B and B⇄A are the same trip
      const e = pairs[k] || (pairs[k] = { pair: k, hits: 0, days: new Set() });
      e.hits++; e.days.add(date);
    }
  }
  return Object.values(pairs)
    .filter((e) => e.hits >= 12 && e.days.size >= 3)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 4)
    .map((e) => ({
      kind: 'pingpong',
      title: `Bouncing between ${e.pair}`,
      detail: `${e.hits} rapid round trips across ${e.days.size} days.`,
      evidence: `A→B→A inside two minutes`,
      estMinPerWeek: Math.round(e.hits / (e.days.size / 7) * 0.25),
      fix: `A comms app pulling you out and straight back. Either the notification can wait, or the two tools should be talking to each other.`,
    }));
}

function report(days = 21, cfg = S.readConfig()) {
  const visits = allVisits(days, cfg);
  const findings = [
    ...authLoops(visits, days),
    ...repeatSearches(visits),
    ...appPingPong(days),
    ...boomerangPages(visits),
  ];
  const estMinPerWeek = findings.reduce((a, f) => a + (f.estMinPerWeek || 0), 0);
  return {
    days,
    visits: visits.length,
    findings,
    estMinPerWeek,
    // Said out loud so the number is never mistaken for a measurement.
    note: 'Time figures are estimates from counts, not measured durations.',
  };
}

module.exports = { report, authLoops, repeatSearches, boomerangPages, appPingPong };
