# Architecture

WiseM3U is a single-process Node.js/Express application. It does not use a
database: the configuration is a JSON file on the data volume and caches are
files on disk (with "hot" trees kept in RAM).

## Layout

```
src/
  server.js            Express app composition, public media routes and bootstrap
  routes/
    lists.js           lists API: CRUD, state, refresh, channels, preview, Xtream
    history.js         configuration history: list, restore, checkpoint, undo
    trash.js           trash: delete, list, restore, empty
  http/
    request.js         token/admin middleware, base URL and request helpers
  services/
    refresher.js       background downloads, startup reconciliation, auto-refresh
    listM3u.js         M3U export for preview and personal lists
  easyproxy.js         EasyProxy client (IP/DNS resolution, test requests)
  config.js            atomic config read/write, normalization, revisioning
  history.js           on-disk snapshots, per-category diff, retention, checkpoints
  cache.js             gzip tree snapshots + in-RAM LRU
  wiseplay.js          WisePlay, M3U and M3U_PLUS download/parsing
  playlist.js          flattening, Stremio/Nuvio catalogs, final M3U, personal lists
  epg.js               XMLTV download/parsing, channel matching, Now/Next and Native EPG videos
  m3u.js               M3U parser and builder
  selection.js         branch selection (exclusions, keywords)
  protocols.js         protocol and URL detection
  imgfit.js            logo resizing
  streamdiag.js        stream diagnostics (opt-in)
  xtream.js            Xtream account info
  liveLog.js           live log ring buffer
  constants.js         version (from package.json), UA, timeouts, limits
public/
  configure.html       configuration page markup
  configure.css        styles (Material 3, dark theme)
  configure.js         page logic (vanilla JS, no build step)
  i18n.js              translations engine
  i18n/*.json          dictionaries (en is the source language)
  manifest.json, logo.svg, ...
tests/                 regression suites run by `npm test`
```

## Request flow

1. `src/server.js` mounts `express.json` (4 MB limit), compression and the
   static files in `public/`.
2. Public routes (`/manifest.json`, `/catalog`, `/playlist.m3u`, streams,
   images) use `requireToken`; `/api/*` routes use `requireAdmin`. Both
   middlewares and the URL/token helpers live in `src/http/request.js`.
3. API routes are `express.Router()` modules under `src/routes/`, mounted on
   `/api/history` and `/api/lists`. The lists router receives the `admin`
   middleware and the shared `refresher`; dependencies (config, cache, history,
   playlist) are imported directly, so the modules stay testable.
4. Downloads are owned by `src/services/refresher.js`: HTTP routes only start a
   background job and return, the UI polls list state, and the scheduler
   re-downloads enabled lists after their per-list TTL. The same module resumes
   downloads interrupted by a restart.
5. `/configure` is served by `configPageHtml()`: the server replaces the only
   `__WM_UI_VERSION__` placeholder in the `wm-ui-version` meta tag. CSS and JS
   are separate static files and `configure.js` reads the version from the meta
   tag (no hardcoded versions).
6. Every stable configuration change goes through `config.saveConfig`, which
   bumps `rev` and records a snapshot in `history` (runtime list state is
   excluded from the comparison). A `PUT /api/config` with an old `baseRev`
   receives **409** and the current state.
7. When an XMLTV URL is configured (manually or inherited from an M3U), the
   addon downloads and caches the guide in `src/epg.js`: channels are matched
   by `tvg-id`, `tvg-name` or normalized name, `/meta` exposes Now/Next and
   programme videos, and the catalog `date` extra returns `metasDetailed`.

## Conventions

- **API errors**: `{ error: "english message" }`, with coherent status codes
  (400 invalid input, 401 token, 404 not found, 409 conflict/not-ready state,
  500 internal error).
- **Config**: never write the file directly; use `store.saveConfig`. Derived or
  obsolete fields are normalized in `normalizeConfig`.
- **History**: stable data goes into `stableConfig`; state changes (`status`,
  `stats`, `fetchedAt`) must not create snapshots.
- **UI**: all user text passes through `esc()` before reaching `innerHTML`; no
  framework, no build step.
- **Secrets**: URLs with credentials and tokens stay on the data volume; the UI
  shows redacted URLs and the APIs are protected by `ADMIN_TOKEN`.

## Test

`npm test` runs the Node suites in sequence (logs, diagnostics, Xtream,
WisePlay, imgfit, history/API, EPG, lists API). The suites start a real server on a
local port and a temporary data volume, so they also verify routes and
configuration page assets.
