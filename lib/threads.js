'use strict';
// Threads — the work that recurs, derived rather than declared.
//
// A tracker tells you that you spent 1h55m in Teams, which is a fact about software. A
// thread tells you the checkout migration ran across six days and has been quiet for three,
// which is a fact about work. Getting from one to the other is the whole point of this file.
//
// Nobody declares a thread. There is no project field to fill in and no setup step, because
// the people who would fill one in do not need the tool.
//
// Two approaches were tried before this one:
//
//   Clustering raw browsing by co-occurrence produced a single 22-day blob. Hub sites —
//   Slack, Notion, Claude — appear in everything, so unrelated work merges through them,
//   and greedy pairwise growth chains it all together.
//
//   What actually worked was already on disk: the model-written notes name the work. A note
//   titled "Interview prep planning" identifies the thread on the first try, where the sites
//   underneath it (linkedin, google, a jobs board) identify nothing.
//
// So the signal is the note, and the two failures above are designed against directly:
// features that appear nearly everywhere are dropped (hub suppression), and a note must
// resemble the cluster's centroid rather than any single member of it (no chaining).

const S = require('./store');
const ID = require('./identifiers');

const SLOT_MIN = 10;

// Words the summariser reaches for constantly. They describe the act of using a computer,
// not the work, so they carry no thread signal.
const STOP = new Set(`
you your the a an and or but for to of in on at with from into over about after before
was were is are be been being had has have did do does doing then than that this these those
i me my we our it its as by if so no not out up down off again more most some such own same
minutes minute hour hours time spent short brief while during between across through
checked reviewed browsed opened read looked viewed visited switched worked working
session sessions window windows tab tabs page pages app apps activity active
morning afternoon evening night today yesterday day days week
low signal noise idle away back forth quick quickly just also very
`.trim().split(/\s+/));

const words = (s) => String(s || '').toLowerCase()
  .replace(/[^a-z0-9\s.-]/g, ' ')
  .split(/\s+/)
  .map((w) => w.replace(/^[.-]+|[.-]+$/g, ''))
  .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));

function lastNDates(days) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    out.push(S.isoDate(d));
  }
  return out;
}

/// Every note in range, turned into a weighted bag of features.
///
/// The unit is the ten-minute note, which already holds parallel work: one note carries the
/// browser tab, the Teams chat and the editor together, so a goal pursued across four apps
/// lands in one place rather than four.
///
/// What decides whether two notes are the same work is identifiers, not prose — see
/// identifiers.js for why window titles are actively harmful here.
function featurize(days) {
  const notes = [];
  const dates = lastNDates(days);
  // One pass over the corpus for the whole range, not one per day.
  let allIds = {};
  try { allIds = ID.forRange(dates); } catch {}
  for (const date of dates) {
    const ids = allIds[date] || {};
    for (const e of S.readEntries(date)) {
      const f = new Map();
      const add = (k, w) => f.set(k, (f.get(k) || 0) + w);
      // A project name is the strongest thing a note carries: it is an identity, not a topic.
      if (e.project) add('p:' + e.project.toLowerCase(), 3);
      for (const s of e.sites) add('s:' + s.toLowerCase(), 2);
      for (const w of words(e.title)) add('w:' + w, 1.5);   // the title is the model's own label
      for (const w of words(e.summary)) add('w:' + w, 1);
      // Files touched, projects, and specific pages. Outweigh every word feature, because
      // touching the same file twice is evidence in a way that sharing a word is not.
      for (const [k, w] of (ids[e.slot] || new Map())) add(k, w);
      if (f.size) notes.push({ entry: e, date, f, at: +new Date(`${date}T${e.start}:00`) });
    }
  }
  return notes;
}

/// Drop features that appear nearly everywhere. This is the fix for the blob: Slack and
/// Chrome and a company intranet are in most of the day, so they connect everything to everything.
function suppressHubs(notes) {
  const df = new Map();
  for (const n of notes) for (const k of n.f.keys()) df.set(k, (df.get(k) || 0) + 1);
  const ceiling = Math.max(3, notes.length * 0.35);
  for (const n of notes) {
    for (const k of [...n.f.keys()]) if (df.get(k) > ceiling) n.f.delete(k);
  }
  return notes.filter((n) => n.f.size >= 2);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const [, v] of a) na += v * v;
  for (const [k, v] of b) { nb += v * v; if (a.has(k)) dot += v * a.get(k); }
  return dot && na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const centroidOf = (members) => {
  const c = new Map();
  for (const m of members) for (const [k, v] of m.f) c.set(k, (c.get(k) || 0) + v / members.length);
  return c;
};

/// Assign each note to the closest cluster it genuinely resembles, comparing against the
/// running centroid rather than any one member. Chaining through a single shared feature is
/// what merged everything last time.
function cluster(notes, threshold = 0.3) {
  const clusters = [];
  for (const n of notes.slice().sort((a, b) => b.f.size - a.f.size)) {
    let best = null, bestSim = 0;
    for (const c of clusters) {
      const sim = cosine(c.centroid, n.f);
      if (sim > bestSim) { bestSim = sim; best = c; }
    }
    if (best && bestSim >= threshold) {
      best.members.push(n);
      best.centroid = centroidOf(best.members);
    } else {
      clusters.push({ members: [n], centroid: new Map(n.f) });
    }
  }
  return clusters;
}

/// Name a thread by borrowing the title of its most central note.
///
/// Stitching the top keywords together produced "Feature Computer History" and "Log Entry
/// Computer-history" — recognisable, but keyword salad rather than names. The model already
/// wrote a real sentence-shaped title for every note, so the thread takes the one nearest
/// its own centre. A project name still wins when there is one, because that is an identity
/// rather than a description.
const titleCase = (s) => s.replace(/\b([a-z])/g, (m) => m.toUpperCase());

function nameOf(c) {
  const top = [...c.centroid.entries()].sort((a, b) => b[1] - a[1]);

  // Deliberately NOT the project field. Clustering on identifiers means several distinct
  // threads legitimately share a project — three separate pieces of work inside ~/day are
  // three threads, and naming them all "Day" makes the list useless. The project is context,
  // not identity, so it becomes a suffix below rather than the name.
  if (c.members && c.members.length) {
    // A usable title says something. Skip the ones that are punctuation, a bare app name,
    // or a fragment the summariser left behind, and take the next-most-central note instead.
    const usable = (t) => {
      const x = String(t || '').replace(/^[\s—–-]+/, '').trim();
      return x.length >= 12 && /[a-z]{3}/i.test(x) && !/^(untitled|activity|no prompt)/i.test(x);
    };
    let best = null, bestSim = -1;
    for (const m of c.members) {
      const sim = cosine(c.centroid, m.f);
      if (sim > bestSim && usable(m.entry.title)) { bestSim = sim; best = m; }
    }
    if (best) {
      // Trim the trailing clause: titles often carry a secondary activity after a comma or
      // semicolon, and the thread is the first thing.
      return best.entry.title.replace(/^[\s—–-]+/, '')
        .split(/[;·]| — |, (?:then|and) /)[0].trim().slice(0, 58);
    }
  }

  const ws = top.filter(([k]) => k.startsWith('w:')).slice(0, 3).map(([k]) => k.slice(2));
  const site = top.find(([k]) => k.startsWith('s:'));
  if (ws.length >= 2) return titleCase(ws.slice(0, 3).join(' '));
  if (site) return site[0].slice(2);
  return ws[0] ? titleCase(ws[0]) : 'Untitled thread';
}

function build(days = 7, opts = {}) {
  const minNotes = opts.minNotes || 3;
  // Single-day threads are shown too, marked as not yet recurring. A coherent piece of work
  // that has only happened once is still the shape of the work; hiding it until it repeats
  // makes the view useless in the first week, which is exactly when someone decides whether
  // to keep the app.
  const minDays = opts.minDays || 1;

  const all = featurize(days);
  const kept = suppressHubs(all);
  const clusters = cluster(kept, opts.threshold || 0.3);

  const today = S.isoDate();
  const threads = clusters.map((c) => {
    const dates = [...new Set(c.members.map((m) => m.date))].sort();
    const last = dates[dates.length - 1];
    const idle = Math.round((+new Date(today + 'T00:00:00') - +new Date(last + 'T00:00:00')) / 864e5);
    const secs = c.members.reduce((a, m) => a + (m.entry.activeSec || 0), 0);
    const tally = (arr) => {
      const t = {};
      for (const m of c.members) for (const x of m.entry[arr]) t[x] = (t[x] || 0) + 1;
      return Object.entries(t).sort((a, b) => b[1] - a[1]).map(([k]) => k);
    };
    return {
      name: nameOf(c),
      notes: c.members.length,
      days: dates.length,
      first: dates[0], last, idleDays: idle,
      // The state is the reason to look: a thread you dropped is the thing worth surfacing.
      state: idle <= 0 ? 'today' : idle <= 1 ? 'active' : idle <= 3 ? 'warm' : 'quiet',
      // Recurring across days is what separates a thread from a single sitting.
      established: dates.length >= 2,
      minutes: Math.round(secs / 60) || c.members.length * SLOT_MIN,
      apps: tally('apps').slice(0, 4),
      sites: tally('sites').slice(0, 4),
      project: (c.members.find((m) => m.entry.project) || { entry: {} }).entry.project || null,
      titles: [...new Set(c.members.map((m) => m.entry.title))].slice(0, 4),
      when: c.members.map((m) => ({ date: m.date, slot: m.entry.slot })),
    };
  })
  .filter((t) => t.notes >= minNotes && t.days >= minDays)
  .filter((t) => {
    // A thread is recurring work. "Sat in a Zoom meeting", "Brief moment in the browser",
    // "Checked WhatsApp" are ambient activity that clusters on app names and generic verbs
    // with nothing underneath. A real thread is anchored: it names a project, a document, or
    // a specific site. Drop clusters that have no anchor and read as pure activity.
    // The thread's name is the model's own verdict on what the cluster is. When it names it
    // after an act of using the computer or a personal errand rather than a piece of work,
    // that is the truth about the cluster, and a stray project field does not redeem it. A
    // hard document anchor is the one thing that overrides a generic name.
    const hasDoc = t.titles.some((x) => /\.(docx?|xlsx?|pptx?|pdf|key)/i.test(x));
    const ambient = /(^|\b)(sat in|brief moment|moment in|checked|browsed|scrolled|skimmed|glanced|caught up|watched|read [a-z ]*messages|researching|ran a|in the browser|zoom meeting|whatsapp|job listing|recruiter|workout|plyometric|linkedin job|news|personal|machine sat|login screen|idle|screen saver|away from)/i.test(t.name);
    return hasDoc || !ambient;
  })
  // Anchored work first: an anchor is the difference between a piece of work and a habit, so
  // it outranks day-count.
  .map((t) => ({ ...t, anchored: !!t.project || t.titles.some((x) => /\.(docx?|xlsx?|pptx?|pdf|key)/i.test(x)) }))
  .sort((a, b) => (b.anchored - a.anchored) || (b.established - a.established) || b.days - a.days || b.minutes - a.minutes);

  // Two threads with the same name are indistinguishable in a list, which defeats the point.
  // Distinguish collisions by what actually separates them: the project, then a site.
  const seen = new Map();
  for (const t of threads) {
    const base = t.name;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    if (n > 1) {
      const qualifier = t.project || t.sites[0] || t.apps[0];
      t.name = qualifier ? `${base} · ${qualifier}` : `${base} (${n})`;
    }
  }

  return {
    days,
    notesConsidered: all.length,
    threads,
    // Notes that belong to no recurring thread are one-offs, and saying how many keeps the
    // list honest about what it did not explain.
    unclustered: all.length - threads.reduce((a, t) => a + t.notes, 0),
    // The reason to open this view: work you picked up and put down.
    openLoops: threads.filter((t) => t.established && (t.state === 'quiet' || t.state === 'warm')),
  };
}

module.exports = { build, featurize, cluster, nameOf };
