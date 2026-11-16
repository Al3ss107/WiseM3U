# WiseM3U — Stremio & Nuvio addon for WisePlay lists and M3U/M3U_PLUS playlists

Turns **WisePlay lists** (the ones shared as short links) **or any M3U/M3U8
playlist — including Xtream Codes M3U_PLUS** into an **M3U playlist** and
**Stremio/Nuvio catalogs**, with a web page to choose **what to use and what to
leave out** of every list.

Self-hosted, a few lightweight dependencies (`express` + `pngjs`/`jpeg-js` for
proportional posters), runs in Docker on any NAS/home server (CasaOS, Portainer,
Synology, Unraid, Raspberry Pi…).

```
https://example.com/list.json  ->  128,768 streams  (57 imported m3u)
https://example.com/other.m3u  ->   15,613 streams  (AceStream + HTTP)
```

The configuration UI is available in **English, Italian, Spanish, French,
German, Portuguese (Brazil), Russian and Simplified Chinese**; English is the
default and the fallback. The language choice is stored in the browser.

---

## 1. Quick start with Docker

```bash
git clone <this-repo> wisem3u && cd wisem3u
docker compose up -d --build
```

Then open **http://SERVER-IP:7300/configure**

### Prebuilt image (no local build)

If the repository CI has published the image to **GitHub Packages**
(`ghcr.io`), you can start it directly — useful on slow ARM hosts:

```bash
docker run -d --name wisem3u --restart unless-stopped \
  -p 7300:7000 \
  -v /PATH/TO/DATA/wisem3u:/data \
  -e TZ=Europe/Rome -e PUBLIC_PORT=7300 \
  ghcr.io/<YOUR-USER>/wisem3u:latest
```

> If the ghcr.io package is private: `docker login ghcr.io` with a PAT
> (`read:packages`) or make it public from *Package settings → Change
> visibility*.

### CasaOS

**Option A — custom App Store (recommended)**

1. CasaOS → *App Store* → **`+`** icon at the top right → *Custom installation*.
2. In the window, switch to the YAML view (*"Edit as text"*) and paste the
   following, then **Submit**:

```yaml
version: "3"
services:
  wisem3u:
    image: wisem3u:latest
    build:
      context: /PATH/WHERE/YOU/CLONED/wisem3u
```

**Option B — plain Docker**<br>
Use the `docker run` command above or import the repository's
`docker-compose.yml` from CasaOS.

---

## 2. Connect it to Nuvio and Stremio

The addon exposes a normal **Stremio manifest**, which Nuvio reads identically:

```
http://SERVER-IP:7300/manifest.json
```

* **Stremio** → *Add-ons* → *Add addon* → paste the URL → *Install*.
* **Nuvio** → *Settings* → *Content & Discovery* → *Add-ons* → *Add Addon* →
  paste the URL → *Install Addon*.

On the `/configure` page you will find the manifest URL with a **⧉ copy**
button. If the addon sits behind **nginx with a personal domain and
certificate**, set *"Public URL"* in the general settings (e.g.
`https://tv.mydomain.com`): the links shown (manifest and playlist) will use
that base instead of the address you opened the page with. Minimal nginx config
(domain + Let's Encrypt):

```nginx
server {
  listen 443 ssl;
  server_name tv.mydomain.com;
  ssl_certificate     /etc/letsencrypt/live/tv.mydomain.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/tv.mydomain.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:7300;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
  }
}
```

Every enabled list with *"Show as catalog"* becomes its own catalog:

* the grid shows **channels** with title and image (channel logo, or group icon
  when the channel has none);
* **individual playlists become genres**: the *"All genres"* dropdown in
  Stremio/Nuvio lists the names of the groups that directly contain channels
  (e.g. `IPTV (test)`, `PRIMAFILA (test)`), at any depth;
* from the configuration page you can **rename** each playlist (the genre
  follows the new name), **reorder** them and **disable** them individually;
* catalogs are **paginated** (`skip`) and support **search** (`search`);
* opening a channel shows its streams.

---

## 3. The M3U playlist

```
http://SERVER-IP:7300/playlist.m3u
```

* works in VLC, TiviMate, IPTV Smarters, Kodi, Perfect Player…
* on the configuration page the playlist URL has a **⧉ copy** button (next to
  the manifest one): paste it into any IPTV app; if you set `publicBaseUrl`
  and/or the token, the copied URL already includes them;
* `group-title` = `ListName › Group › Subgroup` (configurable levels)
* logo, name and deduplication configurable per list
* **integrated EPG**: if an m3u_plus/Xtream source declares the guide
  (`x-tvg-url`/`url-tvg`) or you set an **EPG URL** in the general settings, the
  generated playlist carries it in the `#EXTM3U` header — IPTV apps load the
  program guide by themselves
* an `.m3u8` version is available at the same path with the `.m3u8` extension

> **Typical Xtream errors** — `invalid list` is almost always a URL copied from
> an HTML page/message with `&amp;` instead of `&` (WiseM3U fixes it
> automatically, but check username/password/type: the error shows the beginning
> of the server response). `failed to fetch` with slow/unstable panels: the root
> download has a 60 s timeout and is retried once automatically.

Support endpoints:

| Endpoint | Description |
| --- | --- |
| `GET /configure` | configuration page |
| `GET /manifest.json` | Stremio/Nuvio manifest |
| `GET /playlist.m3u` | unified playlist (`?refresh=1` forces a download) |
| `GET /imgfit?shape=&url=` | proportional logo poster (JPEG on dark background), disk cache, 302 fallback to the original |
| `GET /channels.json` | channel summary and per-list statistics |
| `GET /catalog/tv/<id>.json` | catalog of a list |
| `GET /meta/tv/<id>.json` · `GET /stream/tv/<id>.json` | details and streams |
| `GET /healthz` | Docker healthcheck |

APIs used by the configuration page (also useful for scripts/automation):

| Endpoint | Description |
| --- | --- |
| `GET/PUT /api/config` | read/save the configuration; PUT accepts `baseRev` and returns **409** if the state was changed elsewhere |
| `POST /api/lists` `{url,name}` | add a list (background download) |
| `DELETE /api/lists/:id` | delete a list |
| `POST /api/lists/:id/refresh` | re-download the list in the background |
| `GET /api/lists/:id/state` | download state (for polling) |
| `GET /api/lists/:id/tree` | list branches: playlists with counts, renames and order |
| `GET /api/lists/:id/channels?path=0.0` | channels of a branch (for page management) |
| `GET /api/lists/:id/preview.m3u?path=0.4` | M3U preview of a single branch |
| `POST /api/probe` `{url}` | analyze a URL without saving it |
| `POST /api/easyproxy/test` `{base,password,testUrl}` | (indicative) EasyProxy instance check |
| `POST /api/cache/clear` | clear the cache |
| `GET /api/history?list=:id` | automatic configuration history (optional list filter) |
| `POST /api/history/:id/restore` | restore a snapshot, fully or only selected categories |
| `POST /api/history/checkpoints` `{name}` | save a named checkpoint (does not expire with retention) |
| `POST /api/history/:id/undo` `{listIds}` | undo a destructive operation, restoring the lists to their previous state |

---

## 4. What can be configured

**Per list**

* **List enabled** — include/exclude the whole list.
* **List playlists (branches)** — one row per playlist in the list, with the
  channel count. You can **check/uncheck** to include or exclude it, **rename**
  it by typing in the field (the name becomes the genre in the catalog and in
  `group-title`), **reorder** it by dragging the ☰ handle (the order also
  applies to playlists and catalogs). A filter at the top finds branches by
  name.
* **Individual channels** — with **▸ channels** you expand a playlist and manage
  channels one by one: **exclude**, **rename**, **reorder** (drag) and **move**.
  The group field to the right of each channel (dropdown with existing groups,
  always editable) is followed by two explicit buttons: **➜** moves the channel
  to the chosen or typed group (a non-existing group is created on the fly),
  **↺** moves it back to the original playlist. Moves are saved automatically
  on the server. Custom groups appear as rows with the *custom* badge: they
  become genres in the catalog and `group-title` in the playlist, and can be
  renamed and reordered like the others. Moved channels keep renames,
  exclusions and order (stable keys `path::name`) and survive list refreshes;
  in the destination panel they show the "from …" badge. A filter helps find
  them quickly.
* **Personal lists** — the **⭐ Create custom list** button (next to *Add*)
  creates a list **exactly like normal lists** (same fields: name, group-title
  prefixes, protocols, AceStream, EasyProxy, catalog name…) but without a
  remote URL: you choose its content from *Add content from your lists* (list →
  playlist/branch → channel, or **— the whole playlist —** to mirror all
  channels of that branch, always in sync with the source). Added items appear
  in *List playlists* and are managed exactly like playlists from other lists:
  check to include/exclude, rename, drag to reorder and *▸ channels* to manage
  individual channels (exclude, rename, reorder, move to custom groups). Being a
  real list, you can also expose it as a **Stremio/Nuvio catalog** (*Show as
  catalog*) and it has a dedicated M3U link (`/personal/<id>.m3u`, copyable from
  the card); with *List enabled* it enters the main playlist.
* **Add content from your lists** — every list card (normal *and* personal) has
  a box to pull content from all other lists: single channels or **— the whole
  playlist —** (they enter as additional playlists), with an **editable** channel
  field (suggestions from the selected playlist, including custom names).
  Choosing the *same* list instead **moves** the channel to another playlist or
  to a **custom playlist** created with *+ New playlist* (it appears among the
  playlists and you can move channels there with the group field and ➜).
* **List side menu** — the *☰ Lists* button at the top right opens a menu with
  all lists: click the name to scroll to the card, ▲/▼ to reorder them (the
  order applies to playlists and catalogs).
* **Add channel to a branch** — inside *▸ channels* there is an editable field
  with suggestions (channels from all downloaded lists): type or choose the name
  and press *+ Add*. If the channel belongs to another playlist of the **same
  list** it is **moved** (the source playlist loses it); if it belongs to
  **another list** it is embedded in the chosen branch and **disabled** in the
  source list.
* **List on/off** — the *on/off* button next to *Refresh* completely disables a
  list (imported or personal): it stays configured but disappears from the M3U
  playlist and catalogs until you re-enable it.
* **Drag to move** — drag a **channel** onto another playlist to move it there
  (works across different lists too: it is removed from the source list). Drag
  **a whole playlist to the center of another row** to move all its channels
  inside (at the edges of the row it still reorders).
* **Delete channel/playlist** — the *✕* button next to each channel removes it
  from the list; next to each playlist it deletes the whole playlist with its
  channels (channels you already moved elsewhere stay where they are).
* **🔎 Playlist filters** — *👁 Show enabled* (left of the search) shows only
  enabled playlists; the search filters by original or renamed name. **✓ All**,
  **✗ None** and **✕ Delete selected** act **only on visible playlists**: with an
  active search they do not touch hidden ones.
* **🗑 Trash** — the *Trash* button in the playlist section lists deleted
  channels and playlists, with a **Restore** button for each: the restore is
  faithful, the channel returns to its playlist (or to the group you moved it
  to) exactly as it was before.
* **List refresh** — how often to re-download the list (1440 = daily).

> **Customizations survive refreshes.** Renames, order, excluded branches and
> channels are stored in the configuration and tied to **group position and
> channel name** — never to the URL. When the list is re-downloaded (daily
> auto-refresh or *Refresh*), new links replace old ones and all customizations
> are re-applied automatically: new channels appear, removed ones disappear.
> Only if the provider **renames** a channel or **restructures** the groups does
> the corresponding customization need to be redone.

* **group-title prefix** — list name, none, or custom.
* **Levels in group-title** — 1 to 6 (`List › Group › Subgroup`).
* **Allowed protocols** — HTTP/HLS, AceStream, RTMP, RTSP, others.
* **AceStream** — keep `acestream://`, rewrite it to HTTP via AceStream Engine
  (`http://IP:6878`), or exclude it entirely.
* **Words to exclude** — filter channels by name/group (e.g. `test`, `backup`).
* **Remove duplicates**, **group icon as logo**, **catalog in Stremio/Nuvio**,
  **catalog name**, **list refresh frequency**.
* **EasyProxy (optional)** — routes the list streams through an
  [EasyProxy](https://github.com/realbestia1/EasyProxy) instance (see below).

**Global**

* **Huge lists (Xtream with hundreds of MB)**: m3u files are read in
  **streaming**, line by line, without loading the file into memory. There is no
  MB limit anymore; the real limit is **150,000 channels** (above that the list
  is truncated and the configuration page shows a warning), because it is the
  channel count — not the file size — that weighs on RAM;
* addon name and ID, **list auto-refresh** (default: **1440 minutes = once a
  day**; 0 = disabled), cache lifetime, maximum parse depth, global
  deduplication, **proportional logos in catalogs** (channel posters go through
  `/imgfit`: contain on a dark canvas already at the card proportions — 16:9
  landscape — so clients that crop "cover" do not cut them. Decoding via
  **libvips/sharp**: PNG, JPEG, **WebP, SVG, GIF and ICO** (channel CDNs often
  serve modern formats), 302 fallback to the original; can be disabled),
  **access token** (if set, manifest/playlist/catalogs require `?token=...`),
  **custom User-Agent** (any string used for all outgoing requests: lists,
  branches, Xtream panel, logos. Useful when a panel or CDN returns `403`
  because it recognizes WiseM3U: paste the UA of a browser, VLC or the app you
  use; empty = default). Automatic refresh downloads only expired lists, in
  the background, without blocking anything.

> **AceStream:** `acestream://` requires a compatible client (Ace Player,
> TiviMate with plugin, Kodi + pvr.acestream). If the server has an **AceStream
> Engine** listening (even in another Docker container) use *"Rewrite to HTTP"*
> and set `http://ENGINE-IP:6878`: channels become normal HTTP links.

### "(dns)" lists and EasyProxy

Many WisePlay lists have branches marked **`(dns)`** (e.g. `SKY VAVOO (dns)`,
`DADDY ITALY (dns)`): their streams only open if the domains are resolved with
"clean" DNS (typically Cloudflare) and sometimes only from certain exit IPs.

**Why AdGuard on the server is not enough:** the stream is played by the
**client** (the TV with Stremio/Nuvio, the phone with VLC…), and the client
resolves those domains with **its own** DNS. The DNS configured on the server
(AdGuard Home) only applies to the server: it does not affect playback.

Two solutions:

1. **change the client DNS** (e.g. `1.1.1.1` on TV/phone/router): zero
   configuration in the addon, but not always possible;
2. **EasyProxy**: a proxy for HLS/DASH streams with integrated **Cloudflare
   WARP** and extractors for Vavoo/Daddylive/Sportsonline. If you enable
   **EasyProxy** on a list, WiseM3U rewrites all its HTTP streams as
   `http://EASYPROXY:7860/proxy/manifest.m3u8?url=…`: EasyProxy downloads the
   stream (with its DNS/WARP) and serves it to the client. `acestream://` links
   stay direct (EasyProxy cannot handle them).

On the configuration page, for each list:

* **EasyProxy URL** — **one field**, enter **IP or domain** and it works as
  written: e.g. `http://192.168.10.10:7860` or `https://proxy.mydomain.com`
  (empty = disabled). If the domain is not visible from the container DNS,
  WiseM3U resolves it automatically with public DNS (1.1.1.1/8.8.8.8) and
  connects to the IP presenting the domain in SNI/Host, so the nginx vhost
  answers correctly. Only **local-only** domains (home AdGuard/DNS, not
  resolvable from outside) require the direct IP in the field;
* **API_PASSWORD** — the EasyProxy password, if you set one;
* **Extra parameters** — appended to the proxy request, e.g. `warp=off` to use
  the server's real IP instead of WARP.

### Stream diagnostics (on-screen error)

General setting **Stream diagnostics (video error)**: it solves the *endless
buffering without explanation* in Nuvio/Stremio when a panel refuses the stream.
When enabled, playlists and catalogs deliver "diagnostic" URLs
(`/proxy/play`):

* the stream **works** → a simple 302 redirect to the source: **the video does
  NOT go through the container**, bandwidth stays direct as before;
* the stream **fails** (403, connection limit, server down, dead domain…) → the
  container generates a clean video on the fly with **FFmpeg** explaining the
  error **on screen** (channel, list and reason), and the exact cause also goes
  to the **Live logs** as a `⛔` line.

If you use an HTTPS proxy (nginx/domain), set *Public URL* first. The probe
user-agent is `vlc` by default, variable `STREAM_DIAG_UA`. If FFmpeg is missing
it falls back to a 502 text response. Turn it back to OFF when not needed — URLs
return to the originals directly.
* **Test** — checks *from the container* reachability, password and test proxy
  (`HTTP 200`). It is **only indicative**: WiseM3U only rewrites streams to
  EasyProxy and the **client** (TV/phone) connects. Network or certificate
  errors from the container are shown as a **non-blocking warning**: on many
  home networks the container cannot reach its own public domain (no NAT
  hairpin) or does not trust the certificate, while everything works fine on
  the client.

> **Note:** with EasyProxy active, all video traffic of that list goes through
> the server (and EasyProxy): on small machines consider the available
> bandwidth and enable it only for lists that need it.

### Xtream account expiry

For Xtream lists (URL `get.php?...&username=...&password=...`) the list card
shows a **⏳ badge with the expiry date and remaining days** read from
`/player_api.php`, plus the connection limit if any. Green over 30 days, yellow
under 30, red under 7 or expired. Data is cached for 30 minutes (no new panel
requests on every page open); **click the badge to refresh immediately**. If the
panel is down, the last known information is kept and marked as *stale*.

### Live logs (debug)

At the bottom of the configuration page there is the **Live logs** section: it
shows in real time (refreshed every ~1.5 s) what the addon is doing, without
needing a shell:

* **stream** — every time a client starts a channel: channel name, source list
  and group, start time and **final served URL** (after rewrite/EasyProxy), plus
  the client IP and user-agent;
* **download** — start/end of every list download with duration, stream count
  and the reason for any failure (with the real network cause: DNS, connection
  refused, certificate, HTTP 403/404…);
* **playlist / catalog / system** — playlist.m3u generation, client requests,
  startup events;

with area and text filters, pause, clear and **download** (a .txt file). The same
lines also appear with `docker logs -f wisem3u`. The buffer keeps the last 1000
events (`LIVE_LOG_BUFFER`). ⚠️ Lines contain list URLs (with any credentials):
redact them before sharing.

---

## 5. How it works

The WisePlay format is a JSON tree:

```jsonc
{ "name": "My list", "author": "…", "image": "…",
  "groups": [
    { "name": "ENTRA", "url": "https://…/start.json" },        // reference to another JSON
    { "name": "IPTV",  "url": "https://…/iptv.m3u", "isHost": true }, // m3u to import
    { "name": "Sport", "groups": [ … ], "stations": [ {"name":"…","url":"acestream://…"} ] }
  ] }
```

WiseM3U:

1. follows redirects of short links;
2. reads the JSON **even when dirty** (BOM, trailing commas, control characters,
   HTML around it);
3. if the root is an **M3U playlist** (not JSON) it converts it into an
   equivalent tree: each `group-title` becomes a branch/genre (channels without
   a group go to "General"), logos and names stay as in the playlist — from
   there on everything else applies (branch selection, renames, catalog, M3U
   output). The extended **M3U_PLUS** format is supported: Xtream Codes links
   (`get.php?username=…&password=…&type=m3u_plus&output=ts`) work as a source
   in every respect; `tvg-*` attributes are read even when they contain commas,
   the `#EXTGRP` directive (simple `type=m3u` Xtream lists) is honored, and the
   EPG declared by the source (`x-tvg-url`/`url-tvg`) is inherited by the final
   playlist;
4. recurses into nested `groups` and downloads external references **in
   parallel**;
5. detects on the fly whether a URL returns WisePlay JSON or an `.m3u` (`isHost`
   branches are almost always m3u) and imports the channels;
6. deduplicates repeated URLs in the same group (real lists have many);
7. applies selection, protocol filters, excluded words and deduplication;
8. produces the M3U, catalogs, meta and streams.

> **Sources served by other addons on the same server** — if you use a playlist
> generated by another addon/container as the source URL, that service will work
> on every WiseM3U download: when adding it, with *Refresh*, when the container
> restarts (expired-list check after ~5 s), with daily auto-refresh and when a
> client requests a catalog with expired cache. This is expected: WiseM3U must
> download the source to build its outputs. The only other outbound traffic is
> logos (`/imgfit`, only when a client shows them) and the configured EasyProxy
> (only the Test button).

Robustness and performance (measured on the two sample lists):

* **tolerant JSON**: fixes hand-written gists with trailing commas (`,]`, `},`)
  and empty elements (`[a, ,b]`) without touching strings; ignores WisePlay's
  `import:false` flag (lazy loading: we always resolve, it is the only way to
  show content to Stremio/Nuvio users) and excludes `embed:true` stations (web
  pages that cannot play in Stremio — dead channels);
* full analysis in **a few seconds** (32 parallel fetches), **gzip** disk cache
  written **in the background** (59 MB → ~4 MB) and reload in ~10 ms;
* **tree RAM diet**: only the **gzip** snapshot of each list stays in memory
  (~1/6 of the original size) and is parsed only when needed; at most
  `WM_HOT_TREES` lists stay "hot" (parsed) at a time (LRU, default **1**). With
  100k+ total channels RSS drops considerably compared to keeping them all
  parsed — `/healthz` exposes `rssMB`/`heapMB`/cache to verify it from outside;
* **background list add/refresh**: the page responds immediately and shows the
  state (`fetching` → `ready`) without hanging requests;
* the **manifest is always instant**: genres come from the cached tree and the
  manifest never downloads lists by itself — otherwise clients would time out
  and retry forever;
* playlist and catalogs share the same **memoized** flatten: the second request
  costs ~10 ms even with 100k+ channels;
* unreachable branches block nothing: they are reported in the UI and the rest
  of the list keeps working;
* safety limits: 8 levels, 6,000 nodes, 150,000 streams per list.

---

## 6. Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `7000` | listening port **inside** the container |
| `PUBLIC_PORT` | *(= `PORT`)* | port published on the host (e.g. `7300`): used only to show correct URLs on the configuration page |
| `HOST` | `0.0.0.0` | listening interface |
| `CONFIG_FILE` | `/data/config.json` | configuration file path |
| `CACHE_DIR` | `/data/cache` | gzip snapshot folder |
| `HISTORY_DIR` | `/data/history` | configuration history (JSON snapshots) |
| `HISTORY_MAX` | `60` | maximum number of automatic states kept (named checkpoints stay, up to 50) |
| `HISTORY_DAYS` | `30` | maximum age (days) of automatic states (named checkpoints do not expire) |
| `ADMIN_TOKEN` | *(empty)* | if set, protects `/configure` and `/api/*` |
| `LIVE_LOG_BUFFER` | `1000` | number of events kept in the **live logs** buffer |
| `WM_HOT_TREES` | `1` | how many lists stay **parsed in RAM** together (LRU): raise it if clients often switch between large lists, lower it if RAM is scarce |
| `STREAM_DIAG_UA` | VLC/3.0.20 | user-agent used by `/proxy/play` probes (some panels accept only certain UAs) |
| `STREAM_DIAG_PROBE_TIMEOUT_MS` | `8000` | diagnostic probe timeout before showing the on-screen error |

---

## 7. Development

```bash
npm install
npm start        # local start on http://localhost:7000
                 # (in the container the host port is 7300, see docker-compose.yml)
npm run lint     # ESLint: undefined variables, duplicates, unreachable code
npm test         # regression: logs, diagnostics, Xtream, WisePlay, imgfit, API/history
npm run test:mem # RAM diet test (requires --expose-gc)
```

The configuration page is split into `public/configure.html` (markup),
`public/configure.css` (Material 3 styles), `public/configure.js` (logic) and
`public/i18n.js` + `public/i18n/*.json` (translations): no build step, the
server only injects the version into the `wm-ui-version` meta tag. The module
map and conventions are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); the
complete feature inventory is in [`docs/FEATURES.md`](docs/FEATURES.md).

---

## 8. Common Docker issues

| Symptom | Cause | Solution |
| --- | --- | --- |
| `EISDIR: illegal operation on a directory, read` on `config.json` | On **first start** Docker auto-created `config.json` as a *directory* because the path did not exist on the host | The **entrypoint** of recent images removes/moves it automatically at startup: recreate the container with the latest build. Manually: `sudo rmdir /PATH/TO/DATA/wisem3u/config.json` (or `rm -rf` if empty) and restart |
| `EACCES: permission denied, open '…/config.json.tmp'` | The bind mount inherits the host **root** ownership but the app runs as user `app` | The entrypoint `chown`s the volume and then drops privileges: recreate the container with the latest build. Manually: `sudo chown -R <uid>:<gid> /PATH/TO/DATA/wisem3u` or run the container as root |
| In Stremio/Nuvio the catalog is visible but opening an item shows *"No addon provides metadata"* | The client has an old manifest cached (or the addon was updated without reinstalling) | **Remove the addon and reinstall it** by pasting the `/manifest.json` URL again: the client must re-read `idPrefixes` |
| A list stays stuck on **fetching** on the configuration page | The container restarted while the download was in progress (leftover state) | Current builds **unblock automatically**: on restart (or as soon as you open the page) the download restarts and the page follows it. Refresh with **Ctrl+F5** if you still see the old UI |
| `ERR_SSL_WRONG_VERSION_NUMBER` | The URL is `https://` but the server speaks plain HTTP on that port | Handled **automatically**: WiseM3U retries by swapping `https://` to `http://`. Leave the URL as is |
| `ENOTFOUND domain.name` | The container DNS cannot resolve the domain (expired list, typo or home DNS) | WiseM3U retries automatically with public DNS (1.1.1.1/8.8.8.8). If the message persists, the domain is really gone or the URL has a typo |
| The response is an *HTML web page* | You pasted a preview/share link (Google, Mega…) instead of the file | Copy the **direct link** to the playlist, i.e. the one ending in `.m3u` / `get.php?...&type=m3u_plus...` |
| `Response too large (… MB)` | The URL is not a playlist: it points to a **video/audio file** (`.mp4/.mkv` movie, channel stream), an **archive** (zip/rar) or a binary. The message now reports content-type and **first bytes** | No need to press **Refresh** (the error is definitive and flagged as such): copy the **list** link from the panel — for Xtream it is `.../get.php?username=…&password=…&type=m3u_plus&output=ts`. If the message says "ZIP ARCHIVE", extract the `.m3u` file and upload it from file. **m3u** files no longer have an MB limit: they are read in streaming |
| Playlist served as **gzip** (`.m3u.gz`, even with content-type `application/octet-stream`) | Many panels compress the list and do not declare `Content-Encoding` | Handled **automatically** since 1.5.3: gzip is decompressed (with an output cap) and the list imported. **UTF-16** with/without BOM is also decoded |
| `HTTP 403` | The panel refuses access: wrong credentials, expired account, connection limit or country/user-agent block | Check the credentials by copying the URL from the panel, check the expiry with the provider, or try `output=ts`. If the block is on the **User-Agent**, set a custom one in *General settings* (e.g. `VLC/3.0.20 LibVLC/3.0.20`) |

With the current build both cases fix themselves **on restart**: you do not need
to touch the volume. If you stay on an old build, the two commands above fix it
immediately.

## 9. Notes

* The addon does not host content: it converts public lists provided by the
  user. Make sure you have the rights to use the lists you import.
* If you expose the port on the Internet, set `ADMIN_TOKEN` and/or the *access
  token* on the configuration page.
* WisePlay lists change often: if a group disappears, use *Refresh* on its card.
