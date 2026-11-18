# WiseM3U

**Version 1.1.0**

Self-hosted **Stremio / Nuvio addon** and **M3U generator** for **WisePlay
lists**, **M3U/M3U8** playlists and **Xtream Codes**. It imports the sources,
normalizes groups and channels, applies your choices and exposes everything as:

- a **Stremio/Nuvio manifest** with catalogs, metadata and streams;
- a single **M3U playlist** (plus an `.m3u8` alias) usable in VLC, TiviMate,
  IPTV Smarters, Kodi, Perfect Player and similar apps.

Everything runs in one lightweight Docker container. No database, no external
service, no account: the configuration is a JSON file on a mounted volume.

---

## Quick start

### Docker Compose

```bash
git clone https://github.com/Al3ss107/WiseM3U.git
cd WiseM3U
docker compose up -d --build
```

Open **http://SERVER-IP:7300/configure**.

### Prebuilt image

```bash
docker run -d --name wisem3u --restart unless-stopped \
  -p 7300:7000 \
  -v /path/to/wisem3u-data:/data \
  -e TZ=Europe/Rome \
  -e ADMIN_TOKEN=change-me \
  ghcr.io/al3ss107/wisem3u:latest
```

The image is published for `amd64`, `arm64` and `armv7`.
If the GHCR package is private, run `docker login ghcr.io` with a token that
has `read:packages`, or make the package public in its settings.

### First configuration

1. paste a WisePlay, M3U/M3U8 or Xtream URL in **Add a list**;
2. optionally give it a name and press **Add** — the download continues in the
   background;
3. enable or disable the playlists/channels you want, then press **Save
   configuration**;
4. copy **manifest.json** into Stremio/Nuvio or **playlist.m3u** into an IPTV
   app. The links are copied from the address you used to open `/configure`.

---

## What it does

```text
WisePlay / M3U / Xtream
        │
        ▼
 download → normalize tree → groups and channels
        │
        ├── select, rename, reorder, exclude, move
        ├── per-list protocols, User-Agent, EPG, refresh, EasyProxy
        ▼
 M3U playlist  +  Stremio/Nuvio catalogs and streams
```

The original source is never modified. Renames, exclusions, order and moves are
stored by stable keys and survive list refreshes. Deleted items go to the
built-in trash and can be restored.

---

## Features

### Input formats

- **WisePlay JSON** chains, including nested `groups/url`, tolerant JSON,
  redirects and `isHost` M3U branches.
- **M3U/M3U8** and **Xtream Codes M3U_PLUS**, with `tvg-id`, `tvg-name`,
  `tvg-logo`, `group-title` and `#EXTGRP`.
- **Huge lists**: streaming import with a configurable safety cap (150,000
  channels by default), no unnecessary full-file buffering.
- **Network recovery**: HTTPS→HTTP fallback, self-signed certificates, public
  DNS with connection by IP, retries on temporary failures and clear messages
  for 403/404/HTML/invalid formats.
- **GitHub links**: `blob` URLs are converted to raw files; repository/folder
  pages are rejected instead of being imported as broken channels.

### Lists and channels

- Enable/disable a whole list; refresh, restore to its original state, or
  delete it with confirmation.
- Rename, reorder, filter and merge playlists; restore individual items from the
  trash.
- Per-list settings: `group-title` prefix and depth, allowed protocols,
  AceStream mode, duplicate removal, excluded words, group logo, catalog
  visibility, custom User-Agent, EPG URL, refresh policy and EasyProxy.
- Channel management: rename, exclude, reorder, move to another playlist or a
  custom group, or add a channel from another list.
- **Personal lists**: build a list from individual channels or whole playlists
  of your other lists, with its own catalog and M3U.
- Drag handles and a quick list menu for reordering; all destructive actions ask
  for confirmation and offer an **Undo** toast.

### Refresh

- One global default (6 hours) and a per-list policy:
  **inherit**, **custom interval** or **manual only**.
- The interval field accepts preset choices from a dropdown or a typed value
  (minimum 5 minutes).
- Background scheduler checks once a minute, downloads only due lists, keeps at
  most two downloads running and backs off exponentially after failures.
- Reads use stale-while-revalidate: clients are served the cached copy while the
  new one is downloaded.

### EPG

- **Per-list EPG URL**, with this priority:
  1. the list's own EPG;
  2. the default EPG in the general settings;
  3. the guide declared by the source (`x-tvg-url` / `url-tvg`).
- XMLTV channels are matched by `tvg-id`, `tvg-name` or normalized name.
- **Now/Next** appears in channel details and search; programme rows are exposed
  as Native EPG videos and a dated catalog for Stremio/Nuvio.
- Guides are cached per effective URL set.

### Stremio / Nuvio output

- One catalog per list enabled as catalog; playlist names become **genres**.
- Pagination (`skip`) and search.
- Landscape channel posters and proportional logo rendering through `/imgfit`
  (PNG, JPEG, WebP, SVG, GIF, ICO; sharp/libvips).
- Native EPG programme rows for clients that support them.
- Playback URLs point directly to the source; video traffic does not pass
  through the container (except optional diagnostic error videos).

### Configuration UI

- English, Italian, Spanish, French, German, Portuguese, Russian and Simplified
  Chinese; English is the default and fallback.
- Dark **Dracula** theme, Material 3 layout, collapsible sections and info panels
  next to titles.
- Responsive phone layout with compact header, floating Save and back-to-top
  buttons.
- Live logs with text filter, pause, clear and download.
- Configuration history with named checkpoints and selective restore; every
  stable change creates a snapshot. `PUT /api/config` uses `rev`/`baseRev` to
  detect conflicts (HTTP 409) instead of overwriting another tab's changes.
- **Stream diagnostics** (opt-in): when a stream fails, the player receives an
  explanatory error video made with FFmpeg, and the exact cause appears in the
  logs.
- **Xtream account badge**: expiry and connection limit read from
  `player_api.php`.
- **EasyProxy** (optional): rewrite streams through an external HLS/DASH proxy
  with its own DNS/WARP/extractors.

### Reliability and security

- `/configure` and `/api/*` are protected by **`ADMIN_TOKEN`** when set.
- Client endpoints (manifest, playlist, catalogs, metadata, streams, images) are
  public by design.
- No access tokens are embedded in generated URLs.
- Configuration history and list URLs stay on the data volume.
- Graceful handling of unhandled rejections; downloads interrupted by a restart
  are resumed.
- `ADMIN_TOKEN` accepts `?token=…`, the `x-access-token` header or the
  `access_token` query parameter.

---

## Public endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /manifest.json` | Stremio/Nuvio addon manifest |
| `GET /playlist.m3u` · `/playlist.m3u8` | unified M3U playlist |
| `GET /catalog/tv/<id>.json` | list catalog (pagination, search, date) |
| `GET /meta/tv/<id>.json` · `/stream/tv/<id>.json` | channel metadata and streams |
| `GET /personal/<id>.m3u` | M3U of one personal list |
| `GET /imgfit?shape=&url=` | resized channel logo/poster |
| `GET /proxy/play?u=` | diagnostic playback proxy (opt-in) |
| `GET /channels.json` | channel statistics per list |
| `GET /healthz` | Docker healthcheck |
| `GET /configure` | configuration page (admin) |

Admin APIs used by the page are under `/api/*`.

---

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `7000` | internal HTTP port |
| `HOST` | `0.0.0.0` | listening address |
| `PUBLIC_PORT` | `PORT` | port shown in startup URLs |
| `CONFIG_FILE` | `/data/config.json` | configuration file |
| `CACHE_DIR` | `/data/cache` | tree snapshots and diagnostic videos |
| `IMGFIT_DIR` | `/data/imgcache` | resized poster cache |
| `ADMIN_TOKEN` | empty | protects `/configure` and `/api/*` |
| `LIVE_LOG_BUFFER` | `1000` | events kept in the live log |
| `WM_HOT_TREES` | `1` | parsed trees kept in memory |
| `WISEM3U_MAX_STATIONS` | `150000` | safety cap per list |
| `STREAM_DIAG_UA` | `vlc` | User-Agent used by stream probes |
| `STREAM_DIAG_PROBE_TIMEOUT_MS` | `8000` | probe timeout |
| `HISTORY_DIR` | `<data>/history` | configuration snapshots |
| `HISTORY_MAX` | `60` | snapshots retained |
| `HISTORY_DAYS` | `30` | snapshot retention in days |
| `NODE_OPTIONS` | empty | `--expose-gc` is added by the entrypoint |

---

## Reverse proxy

The generated links use the current request origin, so open `/configure`
through the public domain. With nginx, forward the original host and scheme:

```nginx
location / {
  proxy_pass http://127.0.0.1:7300;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-Host $host;
}
```

A TLS certificate is recommended when the addon is reachable from the
Internet. Remember to set `ADMIN_TOKEN`.

---

## Data and updates

The container writes configuration, history, cache and posters under `/data`.
Keep that volume when updating the image:

```bash
docker pull ghcr.io/al3ss107/wisem3u:latest
docker stop wisem3u && docker rm wisem3u
# start the container again with the same -v /path/to/data:/data
```

On first start the entrypoint fixes the two common bind-mount problems
(`config.json` created as a directory, root-owned files) and drops privileges to
the `app` user.

---

## Development

```bash
npm ci
npm run lint
npm test
npm start          # http://localhost:7000/configure
```

`npm test` runs the regression suites (URLs, logs, diagnostics, Xtream,
WisePlay, imgfit, history, refresh, EPG, lists API). `npm run test:mem` is an
optional memory stress test.

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — module map, request flow and
  conventions.
- [`docs/FEATURES.md`](docs/FEATURES.md) — complete feature inventory.

## Limitations

- WiseM3U does not host, record or transcode content.
- It is not a player: it prepares playlists, catalogs and EPG metadata.
- It has no database and no multi-user support.
- It cannot bypass DNS blocks by itself; use EasyProxy or fix client DNS.
- Make sure you have the rights to use the lists you import.

## License

MIT — see [`LICENSE`](LICENSE).
