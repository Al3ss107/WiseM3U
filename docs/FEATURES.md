# WiseM3U — complete feature inventory

Reference version: **v1.10.1** (branch `arena/7045a7cd-wisem3u`)

> One line: it imports **WisePlay / M3U / Xtream** lists, normalizes them into a
> tree of groups and channels, applies user customizations and exposes them as a
> **Stremio/Nuvio addon** (catalogs + streams) and as an **M3U playlist** for any
> IPTV app.

---

## 1. Surfaces exposed to clients

| Endpoint | What it does | Protection |
| --- | --- | --- |
| `GET /manifest.json` | Stremio/Nuvio manifest | token (if set) |
| `GET /catalog/tv/<id>.json` | catalog of a list (paginated, search) | token |
| `GET /meta/tv/<id>.json` · `GET /stream/tv/<id>.json` | channel details and streams | token |
| `GET /playlist.m3u` (and `/playlist.m3u8`) | unified playlist of all enabled lists | token |
| `GET /personal/<id>.m3u` | M3U playlist of a single personal list | token |
| `GET /imgfit?shape=&url=` | logo poster as JPEG on a 16:9 (or 1:1) canvas, disk cache | token |
| `GET /channels.json` | channel summary/statistics per list | token |
| `GET /proxy/play` | only with stream diagnostics enabled: redirect or error video | token |
| `GET /healthz` | Docker healthcheck | public |
| `GET /configure` | configuration page | `ADMIN_TOKEN` (if set) |

Admin APIs used by the page (also useful for automation): `/api/config`
(GET/PUT), `/api/lists` (POST/DELETE), `refresh`, `state`, `tree`, `channels`,
`suggest`, `addchannel`, `mergebranch`, `delete`, `deleted`, `restore`,
`preview.m3u`, `xtream`, `/api/probe`, `/api/easyproxy/test`, `/api/cache/clear`,
`/api/logs`, `/api/logs/clear`.

---

## 2. List import and parsing

| Feature | Details |
| --- | --- |
| **WisePlay JSON** | `groups/url` tree, max depth 8, max 6,000 nodes; tolerant JSON (BOM, trailing commas, empty elements, text before/after the payload, `import:false` still resolved, `embed:true` excluded) |
| **M3U / m3u_plus** | `tvg-id/tvg-name/tvg-logo/group-title` attributes, `#EXTGRP`, EPG (`x-tvg-url`/`url-tvg`), per-branch deduplication |
| **Xtream (`get.php`)** | imported as m3u_plus; credential/URL detection |
| **Huge lists** | **streaming** parsing line by line: no MB cap (tested with 581 MB), safety cap of 150,000 channels (configurable), download stopped as soon as the cap is reached, UI warning |
| **Input formats** | raw gzip (even `application/octet-stream`), UTF-8/UTF-16 with and without BOM; magic-number sniffing with explicit messages for ZIP/RAR/7Z, MP4/MKV/AVI/FLV, MPEG-TS/PS |
| **Network recovery** | automatic `https→http`, self-signed certificates, public DNS (1.1.1.1/8.8.8.8) + connection by IP, one retry on transient errors; diagnostic 4xx errors (403/404 explained) |
| **User-Agent** | customizable **per list** (downloads, branches, Xtream panel and logos of that list); default: Chrome 126 + `WiseM3U/x.y`, logos with a "clean" UA |
| **Limits** | branch timeout 20 s, root 60 s, concurrency 32 fetches, 2 GB maximum stream |

---

## 3. Normalization and customizations

| Feature | Details |
| --- | --- |
| **Group tree → branches** | every group with channels becomes a "playlist" (branch), at arbitrary depth |
| **Branch/channel rename** | stable keys `path::name`, survive refreshes |
| **Branch/channel exclusion** | checkbox per branch, ✕ per channel (with trash) |
| **Order** | drag-and-drop for branches and channels, persisted |
| **Moves** | channel → another branch or custom group; whole playlist → inside another; also **across different lists** (disabling at the source) |
| **Custom groups** | created on the fly, behave like branches |
| **Personal lists** | lists without a URL, made of channels/branches from other lists (including "whole playlist"), with their own catalog and M3U |

---

## 4. Configuration page (`/configure`)

**Adding lists** — URL field, optional name, analysis button (`/api/probe`),
background download with state and statistics.

**Per list**

- enable/disable (`on`/`off`), Refresh, **↩ Restore** (returns the list to the
  state it had when added: resets renames, exclusions, order, merges, moves and
  trash, then re-downloads it from the URL), delete, personal M3U link;
- **Xtream account expiry** badge (from `player_api.php`, 30 min cache);
- settings: group-title prefix/levels, protocols, AceStream, deduplication,
  excluded words, group icon, catalog yes/no + name, refresh frequency,
  EasyProxy (URL, password, parameters) + Test;
- **List playlists**: check, rename, drag to reorder (the order is kept across
  other drags until you save), filter, **Show enabled**, **All/None** (limited
  to filter results), **Delete selected**, trash; dragging one playlist onto
  another merges it and asks for confirmation, as do deletion and restore;
- **Trash**: restore individual items and **Empty trash**, which permanently
  deletes only the items currently in the trash (no longer restorable) without
  touching the rest of the list;
- **Channels**: expand, check, rename, reorder, move (group field + ➜/↺ or
  drag), add a channel from other lists, delete; custom group management;
- **Personal lists**: creation, composition from the "Add content from your
  lists" box, managed exactly like normal lists.

**Global** — addon name/ID, auto-refresh, cache TTL, maximum depth, access
token, public URL, EPG URL, global deduplication, proportional logos, stream
diagnostics, clear cache, **interface language**.

**Per list** — name, group-title prefix and depth, catalog name, refresh
frequency, **custom User-Agent**, allowed protocols, AceStream mode, exclusions,
renames/order, EasyProxy.

**Configuration history** — every "stable" change (settings, lists, options)
automatically creates a JSON snapshot in `/data/history`, at most 60 states or
30 days. Runtime list state (download, statistics) is excluded, so history does
not fill with noise. In the "Configuration history" section you can filter by
list and restore **only the selected categories** (order, names, exclusions,
merges/moves, trash, groups, list settings, general settings, list collection);
lists added after the snapshot are not deleted and the admin token is never
restored. A restore creates a new state itself, so it can be undone. Snapshots
contain URLs and credentials: they stay on the data volume and the APIs are
protected by `ADMIN_TOKEN`.

**Undo from the toast** — destructive operations (deleting a list, a playlist
or a channel, merging, emptying the trash, restoring a list) show a toast at the
bottom with an **Undo** button for 9 seconds. Undo returns the involved lists to
their immediately previous state (recreating a deleted list) and is itself
recorded in history.

**Revision and conflicts** — `GET /api/config` exposes `rev`, incremented on
every "stable" change (state updates do not count). The page sends `baseRev` in
the PUT: if another tab, a merge or an automatic operation changed the
configuration in the meantime, the server returns **409** with the current
state instead of overwriting it. The UI asks whether to reload the server
version or cancel the save.

**Named checkpoints** — with **★ Checkpoint** in the history section you save a
state with a chosen name (e.g. "before the merge"). Checkpoints are recorded
even when the configuration is unchanged, appear with their name and do not
expire with automatic retention (the 50 most recent are kept). Restoring a
checkpoint requires the same explicit confirmation as other snapshots and
proposes all categories already checked (uncheck the ones you do not want).

**Live logs** — ring buffer (1000 events, `LIVE_LOG_BUFFER`), areas
stream/download/playlist/catalog/system, text filter, pause, clear, download,
1.5 s polling; the same lines appear in `docker logs -f`.

**List side menu** — quick navigation and list reordering.

**Info and collapsible sections** — every explanation (the old notes under
fields and the "ℹ️ …" blocks) is collected into a round **i** icon **next to the
title** of the section or card it refers to: the panel opens on tap, shows the
notes with the field label and closes by tapping outside or pressing `Esc` (on
desktop it aligns to the icon so it does not leave the screen, on mobile it is a
bottom sheet). The label stays in the DOM as `aria-label`/tooltip. Every section
opens and closes by **tapping the title** (the **▾/▸** arrow on the same row is
only an indicator, not a separate button; Live logs included) and on first load
only **1 Add a list** and **3 Connect Nuvio, Stremio or an IPTV app** are open;
general settings, logs and list cards start collapsed. List cards open by
tapping the name, playlists have their own collapse button with the respective
info in the title, and per-list settings stay in the existing `<details>`. The
open state of lists is preserved across list refreshes. The interface follows
the **Material 3** design (color tokens, cards, tonal buttons, bordered fields
with visible focus). The theme is the dark Dracula palette (deep grey-purple
background with purple accents).

**On phones (≤ 560 px)** — compact (not sticky) header with a smaller logo,
list actions in a 2×2 grid, playlist and channel rows on multiple lines (name
full width, counts and buttons below), 40 px touch targets, 16 px fields to
avoid iOS auto-zoom and no horizontal scrolling. Section number, title, **i**
icon and **▾/▸** button always stay on the same row even on narrow phones. The
footer is no longer fixed: **Save** and **Reload** are two floating buttons on
the same row at the bottom right (together with "☰ Lists" on the left), while
the list count and version stay at the bottom of the page and scroll with the
content. Floating buttons hide when the keyboard is open (measured on
`visualViewport`) so they do not steal space while typing.
On mobile there is also an always-floating **↑** arrow above **Save/Reload**
that scrolls back to the top smoothly (respects `prefers-reduced-motion` and
hides when the keyboard is open). Branch reordering remains drag-and-drop, which
touch browsers do not support: on phones you reorder lists from the side menu,
not branches. The save/refresh button shows a plain `on`/`off` label (no glyph
that Android renders as a missing-character box).

**Languages** — the header has a language selector with English, Italian,
Spanish, French, German, Portuguese (Brazil), Russian and Simplified Chinese.
English is the source language and the fallback; the choice is stored in
`localStorage` and restored on the next visit. Dates and numbers are formatted
with the selected locale.

---

## 5. Output and integrations

| Feature | Details |
| --- | --- |
| **Stremio/Nuvio catalogs** | an enabled list with "show as catalog" becomes a catalog; playlists are the **genres**; `skip` pagination, `search` |
| **M3U playlist** | multi-level `group-title`, logos, EPG, deduplication, protocol filter; `.m3u8` alias |
| **Logos** | `/imgfit` with **sharp/libvips** (PNG, JPEG, WebP, SVG, GIF, ICO), 640×360 landscape or 512×512 square canvas, 10% padding, `#101418` background, JPEG disk cache, 302 fallback |
| **EasyProxy** | stream rewriting to an external instance (HLS/DASH proxy with WARP), with public DNS resolution + connection by IP |
| **Stream diagnostics** | "diagnostic" URLs: if the stream responds → direct 302 (no container transit); if it fails → explanatory video generated with **FFmpeg** + `⛔` line in the logs |
| **Xtream** | reads `/player_api.php` for expiry/connection limit (30 min cache) |
| **Token** | `?token=` on manifest/playlist/catalogs; `ADMIN_TOKEN` for configuration and APIs |
| **Compression** | compressed m3u responses (bandwidth saving) |

---

## 6. Reliability, cache and runtime

- **Disk cache** of trees: `.json.gz` snapshot per list; "hot" tree in memory
  (`WM_HOT_TREES`); automatic refresh only of expired lists.
- **Image cache** separate (`data/imgcache/*.jpg`).
- **Entrypoint** that fixes the two typical bind-mount problems
  (`config.json` created as a directory, root ownership) and switches to the
  `app` user; `su-exec`.
- **Docker healthcheck** on `/healthz`.
- **RAM diet**: GC exposed (`--expose-gc`) and called periodically.
- **Stability**: `unhandledRejection` logged, `uncaughtException` → clean exit.
- **No database**, no mandatory external service, a single container.

---

## 7. Environment variables

| Variable | Default | Role |
| --- | --- | --- |
| `PORT` / `HOST` | `7000` / `0.0.0.0` | listening |
| `PUBLIC_PORT` | = `PORT` | only to print the correct URLs |
| `CONFIG_FILE` | `/data/config.json` | configuration |
| `CACHE_DIR` | `/data/cache` | tree snapshots + error videos |
| `IMGFIT_DIR` | `/data/imgcache` | poster cache |
| `ADMIN_TOKEN` | empty | protects `/configure` and `/api/*` |
| `LIVE_LOG_BUFFER` | `1000` | events kept in the live logs |
| `WM_HOT_TREES` | `1` | how many trees to keep in RAM |
| `WISEM3U_MAX_STATIONS` | `150000` | channel cap per list |
| `STREAM_DIAG_UA` / `STREAM_DIAG_PROBE_TIMEOUT_MS` | VLC / 8 s | stream diagnostics |
| `NODE_OPTIONS` | `--expose-gc` | set by the entrypoint, extensible |

---

## 8. Dependencies and size

**Node runtime**: `express`, `compression`, `sharp` (libvips).

**Docker image**: `node:20-alpine` + `su-exec` + `ffmpeg` + `ttf-dejavu`.

**Code** (lines, approximately):

| Module | Lines | Role |
| --- | --- | --- |
| `src/server.js` | 1,300 | HTTP composition and main routes |
| `src/routes/*.js` | 360 | history and trash modules |
| `src/wiseplay.js` | 1,300 | WisePlay/M3U import, streaming, recovery |
| `public/configure.html` | 245 | UI markup |
| `public/configure.css` | 530 | Material 3 styles |
| `public/configure.js` | 2,100 | UI logic |
| `public/i18n.js` + `public/i18n/*.json` | — | translations (8 languages) |
| `src/playlist.js` | 770 | catalogs, streams, M3U, personal lists |
| `src/config.js` | 370 | persistence, normalization, revisioning |
| `src/history.js` | 310 | snapshots, checkpoints, retention |
| `src/streamdiag.js` | 330 | diagnostics + FFmpeg video |
| `src/cache.js` | 290 | snapshots, TTL, hot trees |
| `src/imgfit.js` | 200 | posters/logos |
| `src/xtream.js` | 120 | account info |
| others (`m3u`, `constants`, `protocols`, `selection`, `liveLog`) | ~380 | support |
| tests | ~1,400 | suites (not in the image) |

**Indicative image size** (check with `docker images`): Alpine base ~50 MB,
`ffmpeg` ~80–110 MB, `ttf-dejavu` ~10 MB, `sharp/libvips` ~30–40 MB, Node
code+deps ~10 MB → **~180–220 MB** total. Without ffmpeg and fonts, about
90–120 MB less.

---

## 9. Slimming candidates (historical notes)

The v1.5.8 cleanup already removed `settings.configPassword`, the
`WISEM3U_MAX_LIST_BYTES`/`_MAX_STREAM_BYTES` overrides and the unused
`tests/mem_probe.js`. The real levers for smoothness and memory are
`WM_HOT_TREES` (trees kept in RAM) and `WISEM3U_MAX_STATIONS` (maximum list
size).

Optional removals with a real image impact: stream diagnostics + FFmpeg/fonts
(~90–120 MB, but the on-screen error video is lost), proportional logos + sharp
(~30–40 MB), EasyProxy, the Xtream expiry badge and live logs (no image impact,
but features are lost). Structural simplifications (per-channel management,
personal lists, trash, custom groups, `/channels.json`) reduce complexity, not
image size.

## 10. What it does NOT do

- **it does not host or transcode** content: no video passes through it, except
  the short diagnostic error videos (optional);
- it is not a player and does not provide an EPG (it only declares one);
- it has no database and no multi-user support;
- it does not bypass DNS blocks by itself: EasyProxy or the client DNS is
  required for that.
