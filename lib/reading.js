'use strict';
// Reading — the substantive things you looked at, across every app, not just the browser.
//
// A document you opened in Word, a page you read in Chrome, a spec in Notion, a PDF in
// Preview: all of it is content you engaged with, and all of it shows up in window titles and
// the browser history. This gathers it into one place and strips the noise.
//
// The bar is deliberately low. Anything that looks like work or reference material is kept,
// even if you only touched it once, because a spec you opened for two minutes is still a thing
// you read. What gets dropped is entertainment, news fronts and utility chrome — the pages you
// reload without reading. When unsure, it keeps.

const S = require('./store');
const B = require('./browsers');

// Hosts that are entertainment, news fronts, or social feeds. Their pages are glances, not
// reading, and they drown everything else. Matched as substrings of the hostname.
const NOISE_HOST = /(google\.[a-z.]+$|bing\.com|duckduckgo|search\.|ndtv|news18|hindustantimes|timesofindia|indiatimes|cnn\.|bbc\.|reuters|toi\.|zeenews|aajtak|youtube|netflix|spotify|primevideo|hotstar|instagram|facebook|twitter|x\.com|tiktok|reddit\.com|speedtest|amazon\.|flipkart|myntra|swiggy|zomato|espn|cricbuzz)/i;

// Titles that are navigation or utility chrome rather than a document.
const NOISE_TITLE = /^(inbox|sent|drafts|calendar|home|feed|notifications|new tab|settings|breaking news|latest news|.*\bjoin\b.*zoom|.* - outlook$|.*sign ?in.*|untitled|search results?|.*\| *linkedin$)/i;

// Apps whose windows are worth reading content from, beyond the browser. Editors, doc apps,
// PDF viewers, note tools. Comms and terminals are excluded — a Teams window is a conversation,
// handled by People, not a document you read.
const READ_APP = /word|excel|powerpoint|pages|numbers|keynote|preview|acrobat|notion|obsidian|confluence|notes|textedit|pdf|books|kindle|marginnote/i;

// A doc filename anywhere in a title, in any app.
const DOC_RX = /([A-Za-z0-9 _\-]{6,}\.(?:docx?|pptx?|xlsx?|pdf|md|key|pages|numbers))/;

const isWorky = (title, host) => {
  const t = String(title || '');
  if (t.length < 15) return false;
  if (NOISE_TITLE.test(t.trim())) return false;
  if (host && NOISE_HOST.test(host)) return false;
  return true;
};

function lastNDates(days) {
  const out = [];
  for (let i = 0; i < days; i++) { const d = new Date(); d.setDate(d.getDate() - i); out.push(S.isoDate(d)); }
  return out;
}

/// Everything read over the range, one row per distinct piece, ranked by how much time and how
/// many days it drew. Browser pages and any document title from any app both feed it.
function build(days = 14) {
  const dates = lastNDates(days);
  const items = {};   // key -> record

  const add = (key, { title, host, source, app, ts }) => {
    const r = items[key] || (items[key] = { key, title, host: host || '', source, apps: {}, secs: 0, days: new Set(), last: 0 });
    r.secs += 15;                                 // one sample ~ the interval
    r.days.add(S.isoDate(new Date(ts)));
    r.apps[app] = (r.apps[app] || 0) + 1;
    if (ts > r.last) r.last = ts;
    // keep the longest, most specific title seen
    if (title && title.length > (r.title || '').length) r.title = title;
  };

  // 1. Browser reading — pages, keyed by host+path so revisits merge, homepages excluded.
  const end = +new Date(dates[0] + 'T23:59:59'), start = +new Date(dates[dates.length - 1] + 'T00:00:00');
  for (const v of B.visitsBetween(start, end, S.readConfig())) {
    let host = '', path = '';
    try { const u = new URL(v.url); host = u.hostname.replace(/^www\./, ''); path = u.pathname; } catch { continue; }
    if (path.length <= 1) continue;               // a bare homepage is not a read
    if (/\/search\b/.test(path) || /[?&]q=/.test(v.url || '')) continue;   // a query, not a read
    if (/okta|\/(callback|oauth2?|login|signin|sso|authorize|auth)\b|session_hint|AUTHENTICATED/i.test(v.url || '')) continue;   // auth plumbing
    if (!isWorky(v.title, host)) continue;
    add(host + path.slice(0, 40), { title: v.title, host, source: 'web', app: 'browser', ts: v.ts });
  }

  // 2. Documents open in any app — Word, Preview, Notion, etc., from window titles.
  for (const date of dates) {
    for (const r of S.readRaw(date)) {
      const ts = +new Date(r.ts);
      const doc = (r.title || '').match(DOC_RX);
      if (doc) { add('doc:' + doc[1].toLowerCase(), { title: doc[1], source: 'doc', app: r.app, ts }); continue; }
      // A reading app with a substantive title but no filename — a Notion page, a PDF chapter.
      if (READ_APP.test(r.app) && isWorky(r.title)) {
        add(r.app + ':' + (r.title || '').slice(0, 40), { title: r.title, source: 'app', app: r.app, ts });
      }
    }
  }

  const today = S.isoDate();
  const list = Object.values(items)
    .map((r) => ({
      title: r.title, host: r.host, source: r.source,
      app: Object.entries(r.apps).sort((a, b) => b[1] - a[1])[0][0],
      minutes: Math.max(1, Math.round(r.secs / 60)),
      days: r.days.size,
      lastSeen: S.isoDate(new Date(r.last)),
      daysAgo: Math.round((+new Date(today) - r.last) / 864e5),
    }))
    // A real read is either time spent or a document that exists at all. One 15s web glance
    // that is not a doc drops out; a doc you opened once stays, per the liberal bar.
    .filter((r) => r.source !== 'web' || r.minutes >= 1)
    .sort((a, b) => b.minutes - a.minutes || b.days - a.days);

  return {
    days, count: list.length,
    items: list,
    bySource: { web: list.filter((r) => r.source === 'web').length,
                doc: list.filter((r) => r.source === 'doc').length,
                app: list.filter((r) => r.source === 'app').length },
  };
}

module.exports = { build, isWorky };
