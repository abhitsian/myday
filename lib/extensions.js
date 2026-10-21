// extensions.js — loads local extensions from ~/.myday/extensions.
//
// My Day ships the things every Mac has: apps, browsing, Claude Code, on-screen text, the
// device's own record. Anything past that is somebody's particular working life — a task
// tracker, a health watch, a morning brief pulled from a calendar nobody else has — and it
// does not belong in a package other people install.
//
// So it lives outside the repo. An extension is a directory under ~/.myday/extensions with
// an extension.js in it. Nothing here names a specific extension, and nothing in the repo
// depends on one existing. Delete the directory and this is a clean public app again.
//
// An extension is code you wrote, running in this process, with the same access My Day has.
// That is the point: it needs to reach your own tools. Nothing is sandboxed. Do not install
// an extension you have not read. See docs/extensions.md.

const fs = require('fs');
const path = require('path');
const S = require('./store');

const DIR = path.join(S.ROOT, 'extensions');

// A route key is "<METHOD> /<sub>", mounted under this extension's own namespace so two
// extensions can both declare "/summary" without colliding.
const ROUTE_KEY = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)$/;
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

// The viewer inside the Mac app runs for days. Caching the first read meant an extension
// added afterwards never appeared, and one that was edited kept serving the old code until
// the app was quit and relaunched. So the cache is keyed to what is on disk: the directory
// listing plus the mtime and size of every extension.js. A handful of stat calls per page
// load, and an edit shows up on refresh.
let cache = null;
let cacheKey = '';

function diskKey() {
  let ids = [];
  try {
    ids = fs.readdirSync(DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name).sort();
  } catch { return 'none'; }
  return ids.map((id) => {
    try {
      const st = fs.statSync(path.join(DIR, id, 'extension.js'));
      return `${id}:${st.mtimeMs}:${st.size}`;
    } catch { return `${id}:absent`; }
  }).join('|');
}

function readOne(id) {
  const dir = path.join(DIR, id);
  const entry = path.join(dir, 'extension.js');
  if (!fs.existsSync(entry)) return null;
  if (!ID.test(id)) return { id, dir, error: 'directory name must be lowercase letters, digits and dashes' };

  let mod;
  try {
    // Dropped from the require cache first so `myday view` picks up an edit on restart
    // without a reinstall, which is how these actually get written.
    delete require.cache[require.resolve(entry)];
    mod = require(entry);
  } catch (e) {
    return { id, dir, error: e && e.message ? e.message : String(e) };
  }
  if (!mod || typeof mod !== 'object') return { id, dir, error: 'extension.js must export an object' };

  const routes = {};
  for (const [key, fn] of Object.entries(mod.routes || {})) {
    const m = ROUTE_KEY.exec(key.trim());
    if (!m) return { id, dir, error: `bad route "${key}" — expected "GET /thing"` };
    if (typeof fn !== 'function') return { id, dir, error: `route "${key}" is not a function` };
    routes[`${m[1]} /api/ext/${id}${m[2] === '/' ? '' : m[2]}`] = fn;
  }

  const tab = mod.tab
    ? { id, label: String(mod.tab.label || mod.name || id), render: String(mod.tab.render || 'render.js') }
    : null;

  return {
    id,
    dir,
    name: String(mod.name || id),
    tab,
    routes,
    enrich: typeof mod.enrich === 'function' ? mod.enrich : null,
    events: typeof mod.events === 'function' ? mod.events : null,
    config: mod.config && typeof mod.config === 'object' ? mod.config : {},
    error: null,
  };
}

// One bad extension is its own problem. It gets recorded and skipped, and the app starts.
function load({ fresh = false } = {}) {
  const key = diskKey();
  if (cache && !fresh && key === cacheKey) return cache;

  let ids = [];
  try {
    ids = fs.readdirSync(DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name).sort();
  } catch { ids = []; }

  cache = ids.map(readOne).filter(Boolean);
  cacheKey = key;
  for (const x of cache) if (x.error) console.error(`extension "${x.id}" skipped: ${x.error}`);
  return cache;
}

const ok = (opts) => load(opts).filter((x) => !x.error);

const tabs = (opts) => ok(opts).map((x) => x.tab).filter(Boolean);
const enrichers = (opts) => ok(opts).filter((x) => x.enrich).map((x) => ({ id: x.id, fn: x.enrich }));

function routes(opts) {
  const all = {};
  for (const x of ok(opts)) Object.assign(all, x.routes);
  return all;
}

function configDefaults(opts) {
  const all = {};
  for (const x of ok(opts)) for (const [k, v] of Object.entries(x.config)) all[`${x.id}.${k}`] = v;
  return all;
}

// Static assets for a tab, served at /ext/<id>/<rel>. Resolved inside the extension's own
// directory and checked after resolution, so "../../.ssh/id_rsa" cannot walk out of it.
function staticFile(id, rel) {
  const x = ok().find((e) => e.id === id);
  if (!x) return null;
  const full = path.resolve(x.dir, rel);
  const base = path.resolve(x.dir) + path.sep;
  if (!full.startsWith(base) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  return full;
}

// Called by rollup once the real session has been stamped in. A note is Markdown, so this
// works on its front matter as an ordered map and puts the body back untouched. Extensions
// add keys — a workstream, a meeting, a ticket. They do not get to rewrite what was
// captured, so the measured keys are restored after every extension has had its turn.
const CAPTURED = ['start', 'end', 'apps', 'sites', 'active', 'generator', 'session', 'project'];

function enrich(md, window) {
  const list = enrichers();
  if (!list.length) return md;

  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(md);
  if (!m) return md;

  const meta = {};
  const order = [];
  for (const line of m[1].split('\n')) {
    const kv = /^([a-zA-Z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (!(kv[1] in meta)) order.push(kv[1]);
    meta[kv[1]] = kv[2].trim();
  }
  const captured = {};
  for (const k of CAPTURED) if (meta[k] !== undefined) captured[k] = meta[k];

  let out = meta;
  for (const { id, fn } of list) {
    try {
      const next = fn({ ...out }, window);
      if (next && typeof next === 'object') out = next;
    } catch (e) {
      console.error(`extension "${id}" enrich failed: ${(e && e.message) || e}`);
    }
  }
  Object.assign(out, captured);

  // Original key order first so a note still reads the way it always did, then whatever
  // the extensions added. A value set to null or undefined drops the key.
  const keys = [...order.filter((k) => out[k] !== undefined && out[k] !== null),
    ...Object.keys(out).filter((k) => !order.includes(k) && out[k] !== undefined && out[k] !== null)];
  const front = keys.map((k) => `${k}: ${String(out[k]).replace(/\n/g, ' ')}`).join('\n');
  return `---\n${front}\n---\n${m[2].startsWith('\n') ? '' : '\n'}${m[2]}`;
}

// Items an extension puts on the timeline rail for a date: things you did that the
// machine did not see as a 10-minute note, such as a deep work session you started.
// Each item needs a start ("HH:MM") and a title; a broken extension adds nothing.
function events(date) {
  const out = [];
  for (const x of ok().filter((e) => e.events)) {
    try {
      const list = x.events(date) || [];
      for (const ev of list) {
        if (!ev || !/^\d{2}:\d{2}$/.test(ev.start || '') || !ev.title) continue;
        out.push({ ...ev, ext: x.id });
      }
    } catch (e) {
      console.error(`extension "${x.id}" events failed: ${(e && e.message) || e}`);
    }
  }
  return out;
}

module.exports = { DIR, load, tabs, routes, enrichers, enrich, events, configDefaults, staticFile };
