# WiseM3U — inventario completo delle funzionalità

Versione di riferimento: **v1.5.8** (branch `arena/7045a7cd-wisem3u`)

> A cosa serve, in una riga: importa liste **WisePlay / M3U / Xtream**, le
> normalizza in un albero di gruppi e canali, applica le personalizzazioni
> dell'utente e le espone come **addon Stremio/Nuvio** (cataloghi + stream) e
> come **playlist M3U** per qualsiasi app IPTV.

---

## 1. Superfici esposte ai client

| Endpoint | Cosa fa | Protezione |
| --- | --- | --- |
| `GET /manifest.json` | manifest Stremio/Nuvio | token (se impostato) |
| `GET /catalog/tv/<id>.json` | catalogo di una lista (paginato, ricerca) | token |
| `GET /meta/tv/<id>.json` · `GET /stream/tv/<id>.json` | dettagli canale e stream | token |
| `GET /playlist.m3u` (e `/playlist.m3u8`) | playlist unificata di tutte le liste attive | token |
| `GET /personal/<id>.m3u` | playlist M3U di una singola lista personale | token |
| `GET /imgfit?shape=&url=` | poster del logo in JPEG su tela 16:9 (o 1:1), cache su disco | token |
| `GET /channels.json` | riepilogo canali/statistiche per lista | token |
| `GET /proxy/play` | solo con diagnostica stream attiva: redirect o video d'errore | token |
| `GET /healthz` | healthcheck Docker | pubblico |
| `GET /configure` | pagina di configurazione | `ADMIN_TOKEN` (se impostato) |

API di amministrazione usate dalla pagina (utili anche per automazioni):
`/api/config` (GET/PUT), `/api/lists` (POST/DELETE), `refresh`, `state`, `tree`,
`channels`, `suggest`, `addchannel`, `mergebranch`, `delete`, `deleted`,
`restore`, `preview.m3u`, `xtream`, `/api/probe`, `/api/easyproxy/test`,
`/api/cache/clear`, `/api/logs`, `/api/logs/clear`.

---

## 2. Import e parsing delle liste

| Funzione | Dettagli |
| --- | --- |
| **WisePlay JSON** | albero `groups/url`, profondità max 8, max 6.000 nodi; JSON "tollerante" (BOM, virgole finali, elementi vuoti, testo prima/dopo il payload, `import:false` risolto comunque, `embed:true` escluso) |
| **M3U / m3u_plus** | attributi `tvg-id/tvg-name/tvg-logo/group-title`, `#EXTGRP`, EPG (`x-tvg-url`/`url-tvg`), deduplica per ramo |
| **Xtream (`get.php`)** | importata come m3u_plus; riconoscimento credenziali/URL |
| **Liste enormi** | parsing **in streaming** riga per riga: nessun tetto di MB (testata con 581 MB), tetto di sicurezza 150.000 canali (configurabile), download interrotto appena raggiunto il tetto, avviso in UI |
| **Formati in ingresso** | gzip "nudo" (anche `application/octet-stream`), UTF-8/UTF-16 con e senza BOM; sniff dei magic number con messaggi espliciti per ZIP/RAR/7Z, MP4/MKV/AVI/FLV, MPEG-TS/PS |
| **Recovery di rete** | `https→http` automatico, certificati self-signed, DNS pubblici (1.1.1.1/8.8.8.8) + connessione per IP, un retry sui transienti; errori 4xx diagnostici (403/404 spiegati) |
| **User-Agent** | personalizzabile globalmente (liste, rami, pannello Xtream, loghi); default: Chrome 126 + `WiseM3U/x.y`, loghi con UA "pulita" |
| **Limiti** | timeout rami 20 s, radice 60 s, concorrenza 32 fetch, 2 GB di stream massimo |

---

## 3. Normalizzazione e personalizzazioni

| Funzione | Dettagli |
| --- | --- |
| **Albero gruppi → rami** | ogni gruppo con canali diventa una "playlist" (ramo); profondità arbitraria |
| **Rinomina rami/canali** | chiavi stabili `percorso::nome`, sopravvivono agli aggiornamenti |
| **Esclusione rami/canali** | checkbox per ramo, ✕ per canale (con cestino) |
| **Ordine** | trascinamento di rami e canali, persistito |
| **Spostamenti** | canale → altro ramo o gruppo personale; intera playlist → dentro un'altra; anche **tra liste diverse** (con disattivazione alla fonte) |
| **Gruppi personali** | creati al volo, si comportano come rami |
| **Liste personali** | liste senza URL, composte da canali/rami presi dalle altre liste (anche "tutta la playlist"), con catalogo e M3U propri |
| **Filtri** | protocolli ammessi (HTTP/HLS, AceStream, RTMP, RTSP, altri), parole escluse, deduplica per lista e globale |
| **AceStream** | `keep` / riscrittura HTTP via Engine / `off` |
| **Prefisso e livelli group-title** | nome lista / nessuno / custom; da 1 a 6 livelli |
| **Logo** | logo canale, fallback icona del gruppo; opzione `fitLogos` |
| **EPG** | ereditata dalle sorgenti + URL XMLTV manuale, scritta nell'header della playlist |
| **Cestino** | rami e canali eliminati recuperabili singolarmente o in blocco |

---

## 4. Pagina di configurazione (`/configure`)

**Aggiunta liste** — campo URL, nome opzionale, pulsante di analisi (`/api/probe`),
scaricamento in background con stato e statistiche.

**Per ogni lista**

- attiva/disattiva (`⏻`), Aggiorna, anteprima M3U, elimina, link M3U personale;
- badge **scadenza account Xtream** (da `player_api.php`, cache 30 min);
- impostazioni: prefisso/livelli group-title, protocolli, AceStream, deduplica,
  parole escluse, icona di gruppo, catalogo sì/no + nome, frequenza di
  aggiornamento, EasyProxy (URL, password, parametri) + Test;
- **Playlist della lista**: spunta, rinomina, riordino drag, filtro, **Visualizza
  attive**, **Tutto/Nulla** (limitati ai risultati del filtro), **Cancella
  selezionate**, cestino;
- **Canali**: espandi, spunta, rinomina, riordino, sposta (campo gruppo +
  ➜/↺ oppure drag), aggiungi canale da altre liste, elimina; gestione gruppi
  personali;
- **Liste personali**: creazione, composizione dal riquadro "Aggiungi contenuto
  dalle tue liste", gestione identica alle liste normali.

**Globali** — nome/ID addon, auto-aggiornamento, TTL cache, profondità massima,
token di accesso, URL pubblico, URL EPG, User-Agent personalizzato, deduplica
globale, loghi proporzionati, diagnostica stream, svuota cache.

**Log live** — buffer circolare (1000 eventi, `LIVE_LOG_BUFFER`), aree
stream/download/playlist/catalogo/sistema, filtro testo, pausa, svuota, scarica,
polling 1,5 s; stesse righe in `docker logs -f`.

**Menu laterale liste** — navigazione rapida e riordino delle liste.

---

## 5. Output e integrazioni

| Funzione | Dettagli |
| --- | --- |
| **Cataloghi Stremio/Nuvio** | una lista attiva con "mostra come catalogo" diventa un catalogo; le playlist sono i **generi**; paginazione `skip`, ricerca `search` |
| **Playlist M3U** | `group-title` a livelli, loghi, EPG, deduplica, filtro protocolli; alias `.m3u8` |
| **Loghi** | `/imgfit` con **sharp/libvips** (PNG, JPEG, WebP, SVG, GIF, ICO), tela landscape 640×360 o square 512×512, padding 10%, fondo `#101418`, cache JPEG su disco, fallback 302 |
| **EasyProxy** | riscrittura degli stream verso un'istanza esterna (proxy HLS/DASH con WARP), con risoluzione DNS pubblica + connessione per IP |
| **Diagnostica stream** | URL "diagnostici": se lo stream risponde → 302 diretto (nessun transito dal container); se fallisce → video esplicativo generato con **FFmpeg** + riga `⛔` nei log |
| **Xtream** | lettura `/player_api.php` per scadenza/limite connessioni (cache 30 min) |
| **Token** | `?token=` su manifest/playlist/cataloghi; `ADMIN_TOKEN` per configurazione e API |
| **Compressione** | risposte m3u compresse (risparmio banda) |

---

## 6. Affidabilità, cache e runtime

- **Cache su disco** degli alberi: snapshot `.json.gz` per lista; albero "caldo"
  in memoria (`WM_HOT_TREES`); aggiornamento automatico solo delle liste scadute.
- **Cache immagini** separata (`data/imgcache/*.jpg`).
- **Entrypoint** che corregge i due problemi tipici dei bind-mount
  (`config.json` creato come directory, ownership root) e passa all'utente
  `app`; `su-exec`.
- **Healthcheck** Docker su `/healthz`.
- **Dieta RAM**: GC esposto (`--expose-gc`) e chiamato periodicamente.
- **Stabilità**: `unhandledRejection` loggato, `uncaughtException` → uscita pulita.
- **Nessun database**, nessun servizio esterno obbligatorio, un solo container.

---

## 7. Variabili d'ambiente

| Variabile | Default | Ruolo |
| --- | --- | --- |
| `PORT` / `HOST` | `7000` / `0.0.0.0` | ascolto |
| `PUBLIC_PORT` | = `PORT` | solo per stampare gli URL corretti |
| `CONFIG_FILE` | `/data/config.json` | configurazione |
| `CACHE_DIR` | `/data/cache` | snapshot alberi + video d'errore |
| `IMGFIT_DIR` | `/data/imgcache` | cache poster |
| `ADMIN_TOKEN` | vuoto | protegge `/configure` e `/api/*` |
| `LIVE_LOG_BUFFER` | `1000` | eventi tenuti nei log live |
| `WM_HOT_TREES` | — | quanti alberi tenere in RAM |
| `WISEM3U_MAX_STATIONS` | `150000` | tetto canali per lista |
| `STREAM_DIAG_UA` / `STREAM_DIAG_PROBE_TIMEOUT_MS` | VLC / 8 s | diagnostica stream |
| `NODE_OPTIONS` | `--expose-gc` | impostato dall'entrypoint, estendibile |

---

## 8. Dipendenze e peso

**Runtime Node**: `express`, `compression`, `sharp` (libvips).

**Immagine Docker**: `node:20-alpine` + `su-exec` + `ffmpeg` + `ttf-dejavu`.

**Codice** (righe):

| Modulo | Righe | Ruolo |
| --- | --- | --- |
| `src/server.js` | 1.326 | HTTP, API, tutte le rotte |
| `src/wiseplay.js` | 1.295 | import WisePlay/M3U, streaming, recovery |
| `public/configure.html` | 2.009 | tutta la UI |
| `src/playlist.js` | 772 | cataloghi, stream, M3U, personali |
| `src/config.js` | 344 | persistenza e normalizzazione |
| `src/streamdiag.js` | 332 | diagnostica + video FFmpeg |
| `src/cache.js` | 288 | snapshot, TTL, hot trees |
| `src/imgfit.js` | 197 | poster/loghi |
| `src/xtream.js` | 116 | info account |
| altri (`m3u`, `constants`, `protocols`, `selection`, `liveLog`) | ~380 | supporto |
| test | ~1.130 | suite (non nell'immagine) |

**Peso indicativo dell'immagine** (da verificare con `docker images`):
base Alpine ~50 MB, `ffmpeg` ~80–110 MB, `ttf-dejavu` ~10 MB, `sharp/libvips`
~30–40 MB, codice+deps Node ~10 MB → **~180–220 MB** totali. Senza ffmpeg e
font si scende di ~90–120 MB.

---

## 9. Candidati allo snellimento

### A. Pulizia a costo zero — **già eseguita nella v1.5.8**

| Cosa | Dove | Esito |
| --- | --- | --- |
| `settings.configPassword` | `config.js`, `server.js` | rimosso (era salvato e mascherato, ma nessuna rotta lo verificava); viene eliminato anche dai config già esistenti al salvataggio |
| `WISEM3U_MAX_LIST_BYTES` / `_MAX_STREAM_BYTES` | `wiseplay.js` | override d'ambiente rimossi: i limiti sono costanti (60 MB per risposte non-m3u, 2 GB per gli stream); i test usano parametri espliciti |
| `tests/mem_probe.js` | tests | eliminato (non era usato dalla suite) |

Nessuna di queste voci incideva sulla RAM a runtime: erano solo codice e
superficie di configurazione in più. Le leve reali per fluidità e memoria sono
`WM_HOT_TREES` (alberi tenuti in RAM) e `WISEM3U_MAX_STATIONS` (dimensione
massima di una lista).

### B. Rimozioni con impatto reale sull'immagine

| Cosa | Risparmio immagine | Codice | Impatto |
| --- | --- | --- | --- |
| **Diagnostica stream** (`streamDiag` + `/proxy/play` + video) e quindi `ffmpeg` + `ttf-dejavu` | **~90–120 MB** | ~330 righe + UI | si perde il video d'errore a schermo; gli stream tornano URL diretti. È già opt-in e spenta di default |
| **Loghi proporzionati** (`/imgfit`, `sharp`) | ~30–40 MB | ~200 righe | si perde il poster 16:9 anti-crop; i client tornano a ritagliare le immagini. Si può lasciare come modulo opzionale |
| **EasyProxy** | 0 | ~250 righe (server + UI) | si perde la riscrittura verso proxy esterno con WARP |
| **Badge scadenza Xtream** | 0 | ~110 righe + UI | si perdono scadenza/limite connessioni |
| **Log live** | 0 | ~160 righe + UI | resta `docker logs` |

### C. Rimozioni strutturali (riducono complessità, non l'immagine)

| Cosa | Codice coinvolto | Cosa si perde |
| --- | --- | --- |
| **Gestione per-canale** (rinomina, esclusione, ordine, spostamenti, cestino canali) | gran parte di `playlist.js` + ~600 righe di UI | si tiene solo la gestione dei **rami** |
| **Liste personali** | `playlist.buildPersonalTree` + UI | si tiene solo l'import da URL |
| **Cestino e cancellazione in blocco** | API + UI | eliminazione immediata |
| **Gruppi personali / spostamenti tra liste** | API `addchannel`/`mergebranch` + drag&drop | gestione semplificata |
| **`/channels.json`** | ~20 righe | endpoint di riepilogo (usato solo come link in UI) |

### D. Da tenere (è il cuore del prodotto)

Import WisePlay/M3U/Xtream, parsing in streaming, albero gruppi/canali,
cataloghi Stremio/Nuvio, playlist M3U con EPG, personalizzazioni per ramo,
cache/aggiornamento automatico, token, UI di base.

---

## 10. Cosa NON fa

- **non ospita né trascodifica** i contenuti: non passa video, tranne i brevi
  video d'errore della diagnostica (opzionale);
- non è un player e non fornisce EPG (solo la dichiara);
- non ha database né multiuser;
- non aggira da solo i blocchi DNS: per quello serve EasyProxy o il DNS del client.
