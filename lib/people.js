'use strict';
// People — who you were in contact with, when, and about what, derived from activity.
//
// A personal CRM you never fill in. The names come from the window titles of your meeting,
// chat and mail apps — "Sumanth Venkatagiri" in a Teams thread, a Zoom participant, an Outlook
// sender. Frequency, recency and trend fall out of counting. What you worked on together comes
// from the documents open in the same ten-minute window.
//
// The hard part is not finding names, it is not surfacing non-names. "Two capitalised words"
// catches people and also products ("Web App"), features ("Slate Rename") and the user's own
// name. Those are filtered here: a stop list of product and generic terms, and the account
// owner's own name, which is detected from the Outlook/calendar title that always carries it.

const S = require('./store');

const COMMS = /teams|zoom|outlook|slack|mail|webex|meet|gmail/i;

// Words that are never a person's name in this context. Product and feature vocabulary,
// document-title furniture, and the calendar/meeting chrome that surrounds a real name.
const NOT_A_NAME = new Set(`
Employee Slate Mobile Phase Admin Config Browse Org Chart Profile Home Page Inbox
Notifications Canvas Multi Instance Release Planning Update Connect Cross Meetings
Teams Zoom Outlook Chrome Terminal Microsoft Google Apple New Reply Sign Out Search
Files Activity Calendar Today Tomorrow Draft Sent Sep September August July June
Notes Meeting Call Chat Group Cloud Studio Visual Code Lux Inline Image Detail
Screenshot Web App Bug Bash Widget Status Report Memo Rollout Experience Leadership
Classified Rename Tracker Scope Board Sprint Review Standup Sync Weekly Daily Doc
Document Sheet Slide Deck Folder Channel Thread Message Video Audio Share Screen
Join Workplace Breaking Latest India World Business Markets Sports Cricket
`.trim().split(/\s+/));

const isNamePart = (w) => /^[A-Z][a-z]{1,14}$/.test(w) && !NOT_A_NAME.has(w);

function namesIn(title) {
  const out = new Set();
  for (const m of String(title || '').matchAll(/\b([A-Z][a-z]{1,14})\s+([A-Z][a-z]{1,14})\b/g)) {
    if (isNamePart(m[1]) && isNamePart(m[2])) out.add(`${m[1]} ${m[2]}`);
  }
  return out;
}

const docsIn = (title) => {
  const out = new Set();
  for (const m of String(title || '').matchAll(/([A-Za-z0-9 _\-]{6,}\.(?:docx?|pptx?|xlsx?|pdf))/g)) {
    out.add(m[1].trim());
  }
  return out;
};

/// The account owner's own name, so it can be excluded from their own contact list. Outlook
/// and calendar windows title themselves "Calendar - <you> - Outlook" / "<you> - Outlook",
/// which is the most reliable place it appears. Falls back to a config override.
function detectSelf(dates, cfg = S.readConfig()) {
  if (cfg.selfName) return cfg.selfName;
  const tally = {};
  for (const date of dates) {
    for (const r of S.readRaw(date)) {
      if (!/outlook|calendar/i.test(r.app + (r.title || ''))) continue;
      for (const m of String(r.title || '').matchAll(/\b([A-Z][a-z]+)\s+([A-Z][a-z]+)\b/g)) {
        const n = `${m[1]} ${m[2]}`; tally[n] = (tally[n] || 0) + 1;
      }
    }
  }
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
}

function lastNDates(days) {
  const out = [];
  for (let i = 0; i < days; i++) { const d = new Date(); d.setDate(d.getDate() - i); out.push(S.isoDate(d)); }
  return out.reverse();
}

/// Everyone in contact over the range, ranked, with recency, trend and shared documents.
function build(days = 16) {
  const dates = lastNDates(days);
  const self = detectSelf(dates);
  const P = {};

  for (const date of dates) {
    const rows = S.readRaw(date);
    // Group the day into ten-minute slots so people and the docs open beside them co-occur.
    const slots = {};
    for (const r of rows) {
      const t = new Date(r.ts);
      const slot = `${date} ${S.slotLabel(Math.floor((t.getHours() * 60 + t.getMinutes()) / 10) * 10)}`;
      (slots[slot] = slots[slot] || []).push(r);
    }
    for (const rs of Object.values(slots)) {
      const ppl = new Set(), docs = new Set();
      let channel = '';
      for (const r of rs) {
        if (COMMS.test(r.app)) { for (const n of namesIn(r.title)) ppl.add(n); if (!channel) channel = r.app; }
        for (const d of docsIn(r.title)) docs.add(d);
      }
      for (const name of ppl) {
        if (name === self) continue;
        const p = P[name] || (P[name] = { name, freq: 0, days: {}, channels: {}, docs: {} });
        p.freq++; p.days[date] = (p.days[date] || 0) + 1;
        if (channel) p.channels[channel] = (p.channels[channel] || 0) + 1;
        for (const d of docs) p.docs[d] = (p.docs[d] || 0) + 1;
      }
    }
  }

  const today = S.isoDate();
  const perDay = (p) => { const o = {}; for (const d of dates) o[d] = p.days[d] || 0; return o; };
  const list = Object.values(P)
    .filter((p) => p.freq >= 6)          // a couple of real exchanges, not one stray match
    .map((p) => {
      const dd = Object.keys(p.days).sort();
      const last = dd[dd.length - 1];
      const ago = Math.round((+new Date(today) - +new Date(last)) / 864e5);
      const recent = dd.filter((d) => (+new Date(today) - +new Date(d)) / 864e5 <= 2).reduce((a, d) => a + p.days[d], 0);
      const prior = dd.filter((d) => { const g = (+new Date(today) - +new Date(d)) / 864e5; return g >= 3 && g <= 6; }).reduce((a, d) => a + p.days[d], 0);
      let trend = recent > prior * 1.3 ? 'rising' : recent < prior * 0.6 ? 'fading' : 'steady';
      if (ago >= 5) trend = 'cold';
      const topChan = Object.entries(p.channels).sort((a, b) => b[1] - a[1])[0];
      return {
        name: p.name, freq: p.freq, daysActive: dd.length, lastSeen: last, daysAgo: ago, trend,
        channel: topChan ? topChan[0] : '',
        topics: Object.entries(p.docs).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d]) => d),
        perDay: perDay(p),
      };
    })
    .sort((a, b) => b.freq - a.freq);

  return {
    days, dates, self,
    people: list,
    cold: list.filter((p) => p.trend === 'cold' || p.daysAgo >= 4).sort((a, b) => b.daysAgo - a.daysAgo),
  };
}

module.exports = { build, namesIn, detectSelf };
