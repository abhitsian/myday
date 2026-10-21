# Extensions

My Day records what every Mac has: which app is in front, the pages your browser already
kept, your Claude Code sessions, the text on screen, and the device's own log. Past that,
what matters is particular to you. A task tracker you happen to use. A watch that knows how
you slept. A morning brief assembled from a calendar nobody else can see.

None of that belongs in a package other people install, so it loads from outside the repo.

## Where they live

    ~/.myday/extensions/<id>/extension.js

One directory per extension, named in lowercase letters, digits and dashes. The directory
name is the id. Nothing in My Day names a specific extension, and nothing depends on one
existing — delete the directory and this is a clean public app again.

Keep that directory under its own version control if you want history. It is deliberately
outside the checkout, so no `git add .` here can publish it.

## What an extension is

```js
// ~/.myday/extensions/tickets/extension.js
module.exports = {
  name: 'Tickets',

  // A tab in the viewer. `render` is a file in this directory.
  tab: { label: 'Tickets', render: 'render.js' },

  // Routes are mounted under /api/ext/tickets/ — declare the part after that.
  routes: {
    'GET /open': (req, res, ctx) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ date: ctx.date, open: myTicketCount() }));
    },
  },

  // Called for every note, after capture has settled. Add front matter; that is all.
  enrich: (meta, window) => ({ ...meta, ticket: ticketFor(window) }),

  // Merged into the config defaults under "tickets.".
  config: { project: 'ENG' },
};
```

Every field is optional. An extension with only `enrich` never shows a tab.
Add `events(date)` to put items on the timeline (see below).

### `routes`

Keys are `"<METHOD> /<path>"`. The handler gets `(req, res, ctx)` where `ctx` is:

| | |
|---|---|
| `ctx.date` | the date the viewer is showing, `YYYY-MM-DD` |
| `ctx.url` | the parsed `URL` |
| `ctx.store` | the store module, so you can read notes and config |

You own the response. Nothing is written for you.

### `tab`

`render` is served from your directory at `/ext/<id>/<file>` and loaded as an ES module. It
exports `render(pane, ctx)`:

```js
// ~/.myday/extensions/tickets/render.js
export async function render(pane, ctx) {
  const d = await (await ctx.api('/open?date=' + ctx.date)).json();
  pane.innerHTML = `<div style="padding:18px">${d.open} open</div>`;
}
```

`ctx.api(path, opts)` fetches from your own route namespace. `ctx.date` is the day on
screen. Fill `pane`; the tab strip and switching are handled.

Other files in the directory are served the same way, so a tab can load its own CSS or JSON.

### `enrich`

Runs once per note, after the summarizer and after the real Claude Code session has been
stamped in. It receives the note's front matter as an object and the capture window, and
returns the front matter to write.

Add keys. You cannot change what was measured: `start`, `end`, `apps`, `sites`, `active`,
`generator`, `session` and `project` are restored after every extension has run. Returning
`null` or `undefined` for a key drops it. Original key order is preserved and new keys are
appended, so a note still reads the way it always did.

This is how a note grows a `workstream`, a `meeting` or a ticket id without any of those
concepts existing in the public code.

### `events`

`events(date)` returns items for the timeline rail on that date: things you did that the
machine did not record as a 10-minute note. Each item is shown like a Claude Code session.

```js
events: (date) => [{
  id: 'abc',                 // stable per item, keeps it open across reloads
  start: '09:40',            // required, HH:MM
  title: 'Finish the spec',  // required
  tag: 'Deep work',          // the chip; defaults to the extension id
  meta: '09:40–10:55 · 75m',
  summary: 'One line under the title.',
  body: '## Markdown\n- shown when the title is clicked',
  actions: [{ label: 'Open recording', icon: '▶', route: '/open?id=abc' }], // POSTs to your route
}],
```

An item without a valid `start` or a `title` is skipped. One that throws adds nothing.

## Failure

A extension that throws while loading is reported on stderr and skipped, and the app starts
without it. One that throws inside `enrich` is reported and that note is written unchanged.
A tab whose module fails says so in the pane. Nothing an extension does stops capture.

Errors are also returned by `GET /api/extensions`, which is what the viewer uses to build
the tab strip.

## What this is not

An extension is code you wrote, running in the My Day process, with everything My Day can
reach. There is no sandbox and there are no permissions. That is the point — it has to be
able to talk to your own tools.

Do not install an extension you have not read.
