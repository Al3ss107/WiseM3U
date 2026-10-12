# WiseM3U — addon Stremio & Nuvio per liste WisePlay e playlist M3U/M3U_PLUS

Trasforma le liste **WisePlay** (quelle condivise come link accorciati) **o una qualsiasi
playlist M3U/M3U8 — comprese le M3U_PLUS di Xtream Codes** in una **playlist M3U** e in
**cataloghi Stremio/Nuvio**, con una
pagina web per scegliere **cosa usare e cosa no** di ogni lista.

Self-hosted, poche dipendenze leggere (`express` + `pngjs`/`jpeg-js` per i poster
proporzionati), gira in Docker su qualsiasi NAS/home-server (CasaOS, Portainer,
Synology, Unraid, Raspberry…).

```
https://esempio.it/lista.json  ->  128.768 stream  (57 m3u importate)
https://esempio.it/altra.m3u   ->   15.613 stream  (AceStream + HTTP)
```

---

## 1. Avvio rapido con Docker

```bash
git clone <questa-repo> wisem3u && cd wisem3u
docker compose up -d --build
```

Poi apri **http://IP-DEL-SERVER:7300/configure**

### Immagine precompilata (senza build in locale)

Se la CI del repository ha pubblicato l'immagine su **GitHub Packages**
(`ghcr.io`), puoi avviarla direttamente — utile su host ARM lenti dove la build
in locale richiede molto tempo:

```bash
docker run -d --name wisem3u --restart unless-stopped \
  -p 7300:7000 \
  -v /PERCORSO/DATI/wisem3u:/data \
  -e TZ=Europe/Rome -e PUBLIC_PORT=7300 \
  ghcr.io/<TUO-UTENTE>/wisem3u:latest
```

> Se il package su ghcr.io è privato: `docker login ghcr.io` con una PAT
> (`read:packages`) oppure rendilo pubblico dal menu *Package settings →
> Change visibility*.

### CasaOS

**Opzione A — App Store personalizzata (consigliata)**

1. CasaOS → *App Store* → icona **`+`** in alto a destra → *Installazione personalizzata*.
2. Nella finestra che si apre passa alla vista YAML (*"Modifica come testo"* / icona in alto a destra)
   e incolla questo, poi **Invia**:

```yaml
version: "3"
services:
  wisem3u:
    image: wisem3u:latest
    build:
      context: /PERCORSO/DOVE/HAI/CLONATO/wisem3u
    container_name: wisem3u
    restart: unless-stopped
    network_mode: bridge      # rete bridge di Docker
    ports:
      - "7300:7000"           # host 7300 -> container 7000
    environment:
      - TZ=Europe/Rome
      - PUBLIC_PORT=7300      # porta vista dall'esterno (per gli URL nella UI)
      - ADMIN_TOKEN=          # opzionale: protegge la pagina di configurazione
    volumes:
      - /PERCORSO/DATI/wisem3u:/data
```

3. Apri l'app e vai su `/configure`.

> Il file [`casaos-app.yaml`](casaos-app.yaml) contiene invece il *template app*
> (nome, icona, `index: /configure`, `port_map: "7300"`) se preferisci registrarla
> come template dell'App Store.

**Opzione B — CLI**

```bash
cd wisem3u
docker build -t wisem3u .
docker run -d --name wisem3u --restart unless-stopped \
  --network bridge -p 7300:7000 \
  -v /PERCORSO/DATI/wisem3u:/data \
  -e TZ=Europe/Rome -e PUBLIC_PORT=7300 wisem3u
```

La configurazione e la cache vivono in `/data` dentro il container: se il volume è montato
sopravvivono a riavvii e aggiornamenti.

---

## 2. Collegarlo a Nuvio e Stremio

L'addon espone un normale **manifest Stremio**, che Nuvio legge identico:

```
http://IP-DEL-SERVER:7300/manifest.json
```

* **Stremio** → *Addon* → *Aggiungi addon* → incolla l'URL → *Installa*.
* **Nuvio** → *Impostazioni* → *Content & Discovery* → *Addon* → *Add Addon* → incolla l'URL
  → *Install Addon*.

Nella pagina `/configure` trovi l'URL del manifest con il pulsante **⧉ copia**. Se
l'addon sta dietro **nginx con dominio personale e certificato**, imposta
*"URL pubblico"* nelle impostazioni generali (es. `https://tv.miodominio.it`): i link
mostrati (manifest e playlist) useranno quella base invece dell'indirizzo con cui hai
aperto la pagina. Config nginx minimale (dominio + Let's Encrypt):

```nginx
server {
  listen 443 ssl;
  server_name tv.miodominio.it;
  ssl_certificate     /etc/letsencrypt/live/tv.miodominio.it/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/tv.miodominio.it/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:7300;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
  }
}
```

Ogni lista abilitata e con *"Mostra come catalogo"* attiva diventa un catalogo a sé:

* la griglia mostra i **canali** con titolo e immagine (logo del canale, o icona del
  gruppo se il canale non ne ha uno);
* le **singole playlist diventano generi**: il dropdown *"Tutti i generi"* di
  Stremio/Nuvio elenca i nomi dei gruppi che contengono direttamente i canali
  (es. `IPTV (test)`, `PRIMAFILA (test)`), a qualunque profondità si trovino;
* dalla pagina di configurazione puoi **rinominare** ogni playlist (il genere segue
  il nuovo nome), **riordinarle** e **disattivarle** singolarmente;
* i cataloghi sono **paginati** (`skip`) e supportano la **ricerca** (`search`);
* aprendo un canale vedi i suoi stream.

---

## 3. La playlist M3U

```
http://IP-DEL-SERVER:7300/playlist.m3u
```

* funziona in VLC, Tivimate, IPTV Smarters, Kodi, Perfect Player…
* nella pagina di configurazione l'URL della playlist ha il pulsante **⧉ copia**
  (accanto a quello del manifest): lo incolli in qualsiasi app IPTV; se imposti
  `publicBaseUrl` e/o il token, l'URL copiato li include già;
* `group-title` = `NomeLista › Gruppo › Sottogruppo` (livelli configurabili)
* logo, nome e deduplica configurabili per lista
* **EPG integrata**: se una sorgente m3u_plus/Xtream dichiara la guida
  (`x-tvg-url`/`url-tvg`) o imposti un **URL EPG** nelle impostazioni generali,
  la playlist generata la riporta nell'header `#EXTM3U` — le app IPTV caricano
  la guida programmi da sole
* versione `.m3u8` disponibile allo stesso percorso con estensione `.m3u8`

> **Errori tipici con le liste Xtream** — `lista non valida` quasi sempre è un
> URL copiato da pagina/messaggio HTML con `&amp;` al posto di `&` (WiseM3U lo
> corregge da solo, ma verifica username/password/type: l'errore mostra l'inizio
> della risposta del server). `failed to fetch` con pannelli lenti/instabili: il
> download della radice arriva a 60 s di timeout e viene ritentato una volta in
> automatico.

Endpoint di supporto:

| Endpoint | Descrizione |
| --- | --- |
| `GET /configure` | pagina di configurazione |
| `GET /manifest.json` | manifest Stremio/Nuvio |
| `GET /playlist.m3u` | playlist unificata (`?refresh=1` forza lo scaricamento) |
| `GET /imgfit?shape=&url=` | poster proporzionato del logo (JPEG su fondo scuro), cache su disco, fallback 302 all'originale |
| `GET /channels.json` | riepilogo canali e statistiche per lista |
| `GET /catalog/tv/<id>.json` | catalogo di una lista |
| `GET /meta/tv/<id>.json` · `GET /stream/tv/<id>.json` | dettagli e stream |
| `GET /healthz` | healthcheck Docker |

API usate dalla pagina di configurazione (utili anche per script/automazioni):

| Endpoint | Descrizione |
| --- | --- |
| `GET/PUT /api/config` | leggi/salva la configurazione |
| `POST /api/lists` `{url,name}` | aggiunge una lista (scaricamento in background) |
| `DELETE /api/lists/:id` | elimina una lista |
| `POST /api/lists/:id/refresh` | riscarica la lista in background |
| `GET /api/lists/:id/state` | stato dello scaricamento (per il polling) |
| `GET /api/lists/:id/tree` | rami della lista: playlist con conteggi, rename e ordine |
| `GET /api/lists/:id/channels?path=0.0` | canali di un ramo (per la gestione dalla pagina) |
| `GET /api/lists/:id/preview.m3u?path=0.4` | anteprima M3U di un singolo ramo |
| `POST /api/probe` `{url}` | analizza un URL senza salvarlo |
| `POST /api/easyproxy/test` `{base,password,testUrl}` | verifica (indicativa) un'istanza EasyProxy |
| `POST /api/cache/clear` | svuota la cache |

---

## 4. Cosa si può configurare

**Per ogni lista**

* **Lista attiva** — include/esclude l'intera lista.
* **Playlist della lista (rami)** — una riga per ogni playlist presente nella lista,
  con il conteggio dei canali. Puoi: **spuntare/de-spuntare** per includerla o escluderla,
  **rinominarla** scrivendo nel campo (il nome diventa il genere nel catalogo e nel
  `group-title`), **riordinarla trascinando** la maniglia ☰ (l'ordine vale anche per
  playlist e catalogo). Un filtro in alto trova subito i rami per nome.
* **Singoli canali** — con il pulsante **▸ canali** espandi una playlist e gestisci i
  canali uno per uno: **escludere**, **rinominare**, **riordinare** (trascina) e
  **spostare**. Sotto ogni canale vedi l'**URL della sorgente video** (quella
  originale del pannello, prima di EasyProxy/diagnostica): click per copiarla.
  Con **⚡ risolvi fonte** (su richiesta, senza disturbare il pannello) WiseM3U
  segue i redirect dell'URL fino alla **fonte reale** (CDN/server d'origine):
  canali diversi — anche da liste diverse — che alimentano la stessa sorgente
  video si riconoscono subito, così se una fonte cade sai tutti i canali colpiti;
  la fonte risolta entra anche nel filtro testuale della playlist.
  Il campo gruppo a destra di ogni canale (tendina con i gruppi
  esistenti, sempre scrivibile) seguito da due pulsanti espliciti —
  **➜** sposta il canale nel gruppo scelto o digitato (un gruppo inesistente viene
  creato al volo), **↺** lo riporta nella playlist originale. Lo spostamento viene
  salvato automaticamente sul server. I gruppi personali
  compaiono come righe col badge *personale*: diventano generi nel catalogo e
  `group-title` in playlist, si rinominano e riordinano come gli altri. I canali
  spostati mantengono rename/esclusioni/ordine (chiavi stabili `percorso::nome`) e
  sopravvivono agli aggiornamenti della lista; nel pannello di destinazione compaiono
  col badge "da …". C'è anche un filtro per trovarli subito.
* **Liste personali** — il pulsante **⭐ Crea lista personalizzata** (accanto ad
  *Aggiungi*) crea una lista **identica in tutto alle liste normali** (stessi campi:
  nome, prefissi group-title, protocolli, AceStream, EasyProxy, nome catalogo…) ma
  senza URL remoto: il contenuto lo scegli tu dal riquadro *Aggiungi contenuto dalle
  tue liste* (lista → playlist/ramo → canale, oppure **— tutta la playlist —** per
  specchiare tutti i canali di quel ramo, sempre sincronizzati con la sorgente). Le
  voci aggiunte compaiono in *Playlist della lista* e si gestiscono esattamente come
  le playlist delle altre liste: spunta per includere/escludere, rinomina, riordino
  col trascinamento e *▸ canali* per gestire i singoli canali (escludere, rinominare,
  riordinare, spostare in gruppi personali). Essendo una lista vera puoi anche
  esporla come **catalogo in Stremio/Nuvio** (*Mostra come catalogo*) e ha un link
  M3U dedicato (`/personal/<id>.m3u`, copiabile dalla carta); con la spunta
  *Lista attiva* entra nella playlist principale.
* **Aggiungi contenuto dalle tue liste** — ogni carta lista (normali *e* personali) ha il
  riquadro per pescare da tutte le altre liste: canali singoli o **— tutta la
  playlist —** (entrano come playlist aggiuntive), col campo canale **scrivibile**
  (suggerimenti dalla playlist scelta, nomi personalizzati compresi). Scegliendo la
  *stessa* lista, invece, **sposti** il canale in un'altra playlist o in una
  **playlist personalizzata** creata con *+ Nuova playlist* (compare tra le playlist
  e ci porti i canali anche col campo gruppo e ➜).
* **Menu laterale liste** — il pulsante *☰ Liste* in alto a destra apre un menu con
  tutte le liste: clicchi il nome per scorrere fino alla carta, ▲/▼ per riordinarle
  (l'ordine vale per playlist e cataloghi).
* **Aggiungi canale in un ramo** — dentro i *▸ canali* di una playlist c'è un campo
  scrivibile con suggerimenti (canali di tutte le liste già scaricate): scrivi o scegli
  il nome e premi *+ Aggiungi canale*. Se il canale appartiene a un'altra playlist
  della **stessa lista** viene **spostato** (la playlist di origine lo perde); se
  appartiene a **un'altra lista** viene innestato nel ramo scelto e **disattivato**
  nella lista di origine.
* **Lista attiva / spenta** — il pulsante *⏻* accanto ad *Aggiorna* disattiva del tutto
  una lista (importata o personale): resta configurata ma sparisce da playlist M3U e
  cataloghi finché non la riattivi.
* **Sposta con il trascinamento** — trascina un **canale** sopra un'altra playlist per
  spostarvelo (funziona anche tra liste diverse: viene tolto dalla lista di origine).
  Trascina invece **un'intera playlist al centro di un'altra riga** per spostarci dentro
  tutti i suoi canali (sui bordi della riga continua a riordinare).
* **Elimina canale / playlist** — il pulsante *✕* accanto a ogni canale lo elimina
  dalla lista; accanto a ogni playlist elimina l'intera playlist con i canali che
  contiene (quelli che avevi già spostato altrove restano dov'è ora).
* **🗑 Cestino** — il pulsante *Cestino* nella sezione playlist elenca canali e
  playlist eliminati, con un pulsante **Ripristina** per ognuno: il ripristino è
  fedele, il canale torna nella sua playlist (o nel gruppo in cui l'avevi spostato)
  esattamente com'era prima.
* **Aggiornamento lista** — ogni quanti minuti ri-scaricare la lista (1440 = giornaliero).

> **Le personalizzazioni sopravvivono agli aggiornamenti.** Rinomine, ordine, rami e
> canali esclusi sono salvati nella configurazione e agganciati a **posizione del gruppo
> e nome del canale** — mai all'URL. Quando la lista viene ri-scaricata (auto-refresh
> giornaliero o *Aggiorna*), i nuovi link sostituiscono i vecchi e tutte le
> personalizzazioni vengono riapplicate automaticamente: i canali nuovi compaiono da
> soli, quelli rimossi spariscono. Solo se il provider **rinomina** un canale o
> **ristruttura** i gruppi la personalizzazione corrispondente va rifatta.
* **Prefisso group-title** — nome della lista, nessuno, o personalizzato.
* **Livelli nel group-title** — da 1 a 6 (`Lista › Gruppo › Sottogruppo`).
* **Protocolli ammessi** — HTTP/HLS, AceStream, RTMP, RTSP, altri.
* **AceStream** — lascia `acestream://`, lo riscrive in HTTP via AceStream Engine
  (`http://IP:6878`), oppure lo esclude del tutto.
* **Parole da escludere** — filtra i canali per nome/gruppo (es. `test`, `backup`).
* **Rimuovi duplicati**, **icona di gruppo come logo**, **catalogo in Stremio/Nuvio**,
  **nome del catalogo**, **frequenza di aggiornamento della lista**.
* **EasyProxy (opzionale)** — fa passare gli stream della lista da un'istanza
  [EasyProxy](https://github.com/realbestia1/EasyProxy) (vedi sotto).

**Globali**

* nome e ID addon, **auto-aggiornamento delle liste** (default: **1440 minuti = una
  volta al giorno**; 0 = disattivato), validità della cache, profondità massima di
  analisi, deduplica globale, **loghi proporzionati nei cataloghi** (i poster dei
  canali passano da `/imgfit`: contain su tela scura, cosi' i client che ritagliano
  "cover" non li mostrano zoomati; disattivabile), **token di accesso** (se impostato,
  manifest/playlist/cataloghi richiedono `?token=...`). L'aggiornamento automatico
  scarica solo le liste effettivamente scadute, in background, senza bloccare nulla.

> **AceStream:** `acestream://` serve un client compatibile (Ace Player, Tivimate con
> plugin, Kodi + pvr.acestream). Se il server ha un **AceStream Engine** in ascolto
> (anche in un altro container Docker) usa *"Riscrivi in HTTP"* e indica
> `http://IP-DELL-ENGINE:6878`: i canali diventano normali link HTTP.

### Liste "(dns)" ed EasyProxy

Molte liste WisePlay hanno rami marcati **`(dns)`** (es. `SKY VAVOO (dns)`,
`DADDY ITALY (dns)`): i loro stream si aprono solo se i domini vengono risolti con
DNS "puliti" (tipicamente Cloudflare) e talvolta solo da determinati IP di uscita.

**Perché AdGuard sul server non basta:** a riprodurre lo stream è il **client**
(la TV con Stremio/Nuvio, il telefono con VLC…), ed è il client a risolvere quei
domini con il **suo** DNS. Il DNS configurato sul server (AdGuard Home) vale solo
per il server: non tocca la riproduzione.

Due soluzioni:

1. **cambiare il DNS del client** (es. `1.1.1.1` su TV/telefono/router): zero
   configurazione nell'addon, ma non sempre possibile;
2. **EasyProxy**: un proxy per stream HLS/DASH con **Cloudflare WARP** integrato ed
   estrattori per Vavoo/Daddylive/Sportsonline. Se attivi l'opzione **EasyProxy**
   su una lista, WiseM3U riscrive tutti i suoi stream HTTP come
   `http://EASYPROXY:7860/proxy/manifest.m3u8?url=…`: sarà EasyProxy a scaricare
   il flusso (con il suo DNS/WARP) e a servirlo al client. I link `acestream://`
   restano diretti (EasyProxy non può gestirli).

Nella pagina di configurazione, per ogni lista:

* **URL di EasyProxy** — **un solo campo**, scrivi **IP oppure dominio** e
  funziona com'è scritto: es. `http://192.168.10.10:7860` o
  `https://proxy.miodominio.it` (vuoto = disattivato). Se il dominio non è
  visibile dal DNS del container, WiseM3U lo risolve da solo con i DNS pubblici
  (1.1.1.1/8.8.8.8) e si connette all'IP presentando il dominio in SNI/Host, così
  il vhost nginx risponde correttamente. Solo i domini **esclusivamente locali**
  (AdGuard/DNS di casa, non risolvibili da fuori) richiedono l'IP diretto nel campo;
* **API_PASSWORD** — la password di EasyProxy, se l'hai impostata;
* **Parametri extra** — aggiunti alla richiesta proxy, es. `warp=off` per usare
  l'IP reale del server invece di WARP;

### Diagnostica stream (errore a video)

Impostazione generale **Diagnostica stream (errore a video)**: il problema che
risolve è il *buffering infinito senza spiegazioni* di Nuvio/Stremio quando un
pannello rifiuta lo stream. Attivata, playlist e cataloghi consegnano URL
«diagnostici» (`/proxy/play`):

* lo stream **funziona** → semplice redirect 302 alla fonte: **il video NON
  passa dal container**, la banda resta diretta come prima;
* lo stream **fallisce** (403, limite connessioni, server spento, dominio
  morto…) → il container genera al volo con **FFmpeg** un video pulito che
  spiega l'errore **a schermo** (canale, lista e motivo), e la causa esatta
  finisce anche nei **Log live** come riga `⛔`.

Se usi un proxy HTTPS (nginx/dominio) imposta prima *URL pubblico*. L'user-agent
delle sonde è `vlc` di default, variabile `STREAM_DIAG_UA`. Se FFmpeg manca,
ricade in una risposta testuale 502. Riportala a OFF quando non serve — gli URL
tornano quelli originali direttamente.
* **Test** — verifica *dal container* raggiungibilità, password e proxy di prova
  (`HTTP 200`). È **solo indicativo**: WiseM3U si limita a
  riscrivere gli stream verso EasyProxy e a connettersi è il **client**
  (TV/telefono). Errori di rete o di certificato dal container sono mostrati come
  **avviso non bloccante**: su molte reti di casa il container non raggiunge il
  proprio dominio pubblico (manca il NAT hairpin) o non si fida del certificato,
  pur funzionando tutto regolarmente sul client.

> **Nota:** con EasyProxy attivo tutto il traffico video di quella lista passa dal
> server (e da EasyProxy): su macchine piccole valuta la banda disponibile e
> attivalo solo sulle liste che ne hanno bisogno.

### Scadenza account Xtream

Per le liste Xtream (URL `get.php?...&username=...&password=...`) la scheda
della lista mostra un badge **⏳ con la data di scadenza e i giorni rimanenti**
decurati da `/player_api.php`, più eventuale limite di connessioni. Verde oltre
i 30 giorni, giallo sotto i 30, rosso sotto i 7 o da scaduto. I dati vengono
conservati 30 minuti in cache (niente nuove richieste al pannello ad ogni
apertura); **click sul badge per rileggere subito**. Se il pannello è giù si
conserva l'ultima informazione nota segnalata come *stale*.

### Log live (debug)

In fondo alla pagina di configurazione c'è la sezione **Log live**: mostra in
tempo reale (aggiornata ogni ~1,5 s) cosa fa l'addon, senza bisogno della shell:

* **stream** — ogni volta che un client avvia un canale: nome canale, lista e
  gruppo di origine, ora di avvio e **URL finale servito** (dopo
  riscrittura/EasyProxy), più IP e user-agent del client;
* **download** — inizio/fine scaricamento di ogni lista con durata, conteggio
  stream e motivo dell'eventuale fallimento (con la causa di rete reale: DNS,
  connessione rifiutata, certificato, HTTP 403/404…);
* **playlist / catalogo / sistema** — generazione della playlist.m3u, richieste
  dei client, eventi di avvio;

con filtro per area e testo, pausa, svuota e **scarica** (file .txt). Le stesse
righe appaiono anche con `docker logs -f wisem3u`. Il buffer tiene gli ultimi
1000 eventi (variabile `LIVE_LOG_BUFFER`). ⚠️ Le righe contengono gli URL delle
liste (con le eventuali credenziali): oscurale prima di condividerli.

---

## 5. Come funziona

Il formato WisePlay è un albero JSON:

```jsonc
{ "name": "La mia lista", "author": "…", "image": "…",
  "groups": [
    { "name": "ENTRA", "url": "https://…/inizio.json" },        // riferimento ad altro JSON
    { "name": "IPTV",  "url": "https://…/iptv.m3u", "isHost": true }, // m3u da importare
    { "name": "Sport", "groups": [ … ], "stations": [ {"name":"…","url":"acestream://…"} ] }
  ] }
```

WiseM3U:

1. segue i redirect dei link accorciati;
2. legge il JSON **anche se sporco** (BOM, virgole finali, caratteri di controllo, HTML intorno);
3. se la radice è una **playlist M3U** (non JSON) la converte in un albero equivalente:
   ogni `group-title` diventa un ramo/genere (i canali senza gruppo finiscono in
   "Generale"), logo e nomi restano quelli della playlist — da lì in poi vale tutto il
   resto (selezione rami, rinomine, catalogo, output M3U). È supportato il formato esteso
   **M3U_PLUS**: i link Xtream Codes
   (`get.php?username=…&password=…&type=m3u_plus&output=ts`) funzionano come sorgente a
   tutti gli effetti; gli attributi `tvg-*` vengono letti anche quando contengono virgole,
   la direttiva `#EXTGRP` (liste Xtream `type=m3u` semplici) viene rispettata e l'EPG
   dichiarato dalla sorgente (`x-tvg-url`/`url-tvg`) viene ereditato dalla playlist finale;
4. scende ricorsivamente nei `groups` annidati e scarica i riferimenti esterni **in parallelo**;
5. riconosce al volo se un URL restituisce JSON WisePlay o una `.m3u` (i rami `isHost`
   sono quasi sempre m3u) e importa i canali;
6. deduplica gli URL ripetuti nello stesso gruppo (nelle liste reali ce ne sono parecchi);
7. applica selezione, filtri protocolli, parole escluse e deduplica;
8. produce M3U, cataloghi, meta e stream.

> **Sorgenti servite da altri addon sullo stesso server** — se come URL sorgente usi
> una playlist generata da un altro addon/container, quel servizio
> lavorerà a ogni scaricamento di WiseM3U: all'inserimento, col pulsante *Aggiorna*,
> al riavvio del container (controllo liste scadute dopo ~5 s), con l'auto-refresh
> giornaliero e quando un client chiede un catalogo con la cache scaduta. È il
> comportamento atteso: WiseM3U deve scaricare la sorgente per costruirci sopra i
> propri output. L'unico altro traffico in uscita sono i loghi (endpoint `/imgfit`,
> solo quando un client li mostra) e l'EasyProxy configurato (solo pulsante Test).

Robustezza e prestazioni (misurate sulle due liste di esempio):

* analisi completa in **pochi secondi** (32 fetch paralleli), cache su disco **gzip**
  scritta **in background** (59 MB → ~4 MB) e reload in ~10 ms;
* **aggiunta e aggiornamento delle liste in background**: la pagina risponde subito e
  mostra lo stato (`fetching` → `ready`) senza tenere richieste appese;
* il **manifest è sempre istantaneo**: i generi arrivano dall'albero in cache e il
  manifest non scarica mai le liste da solo — altrimenti i client andrebbero in
  timeout e ritenterebbero all'infinito;
* playlist e cataloghi condividono lo stesso flatten **memoizzato**: la seconda
  richiesta costa ~10 ms anche con 100k+ canali;
* i rami irraggiungibili non bloccano nulla: vengono segnalati nella UI e il resto
  della lista continua a funzionare;
* limiti di sicurezza: 8 livelli, 6.000 nodi, 150.000 stream per lista.

---

## 6. Variabili d'ambiente

| Variabile | Default | Descrizione |
| --- | --- | --- |
| `PORT` | `7000` | porta di ascolto **dentro** il container |
| `PUBLIC_PORT` | *(= `PORT`)* | porta pubblicata sull'host (es. `7300`): usata solo per mostrare gli URL corretti nella pagina di configurazione |
| `HOST` | `0.0.0.0` | interfaccia di ascolto |
| `CONFIG_FILE` | `/data/config.json` | percorso del file di configurazione |
| `CACHE_DIR` | `/data/cache` | cartella degli snapshot gzip |
| `ADMIN_TOKEN` | *(vuoto)* | se impostato, protegge `/configure` e le API `/api/*` |
| `LIVE_LOG_BUFFER` | `1000` | numero di eventi mantenuti nel buffer dei **log live** |
| `STREAM_DIAG_UA` | VLC/3.0.20 | user-agent usato dalle sonde `/proxy/play` (alcuni pannelli accettano solo certi UA) |
| `STREAM_DIAG_PROBE_TIMEOUT_MS` | `8000` | timeout della sonda diagnostica prima di mostrare l'errore a video |

---

## 7. Sviluppo

```bash
npm install
npm start        # avvio locale su http://localhost:7000
                 # (nel container la porta host e' la 7300, vedi docker-compose.yml)
npm test         # batteria di regressione: log live, diagnostica stream, scadenza Xtream
```

---

## 8. Problemi comuni (Docker)

| Sintomo | Causa | Soluzione |
| --- | --- | --- |
| `EISDIR: illegal operation on a directory, read` su `config.json` | Al **primo avvio** Docker ha autocreato `config.json` come *directory* perché il path non esisteva sull'host | L'**entrypoint** delle immagini recenti la rimuove/sposta da solo all'avvio: ricrea il container con l'ultima build. A mano: `sudo rmdir /PERCORSO/DATI/wisem3u/config.json` (o `rm -rf` se vuota) e riavvia |
| `EACCES: permission denied, open '…/config.json.tmp'` | Il bind-mount eredita l'ownership **root** dell'host ma l'app gira come utente `app` | L'entrypoint fa `chown` sul volume e poi cede i privilegi: ricrea il container con l'ultima build. A mano: `sudo chown -R <uid>:<gid> /PERCORSO/DATI/wisem3u` oppure avvia il container come root |
| In Stremio/Nuvio il catalogo si vede ma aprendo una voce appare *"Nessun addon fornisce metadati"* | Il client ha in cache un manifest vecchio (o l'addon è stato aggiornato senza reinstallarlo) | **Rimuovi l'addon e reinstallalo** incollando di nuovo l'URL `/manifest.json`: il client deve rileggere `idPrefixes` |
| Una lista resta bloccata su **fetching** nella pagina di configurazione | Il container è stato riavviato mentre lo scaricamento era in corso (stato residuo) | Dalla build attuale si **sblocca da solo**: al riavvio (o appena apri la pagina) lo scaricamento riparte in automatico e la pagina lo segue. Aggiorna la pagina con **Ctrl+F5** se vedi ancora la vecchia UI |
| `ERR_SSL_WRONG_VERSION_NUMBER` | L'URL è `https://` ma il server parla HTTP semplice su quella porta | Gestito **in automatico**: WiseM3U riprova scambiando `https://` in `http://`. Lascia l'URL così com'è |
| `ENOTFOUND nome.dominio` | Il DNS del container non risolve il dominio (lista scaduta, errore di battitura o DNS di casa) | WiseM3U riprova in automatico coi DNS pubblici (1.1.1.1/8.8.8.8). Se il messaggio resta, il dominio è davvero sparito o c'è un refuso nell'URL |
| La risposta è una *pagina web HTML* | Hai incollato un link di anteprima/condivisione (Google, Mega…) e non il file | Copia il **link diretto** alla playlist, cioè quello che finisce in `.m3u` / `get.php?...&type=m3u_plus...` |
| `HTTP 403` | Il pannello rifiuta l'accesso: credenziali errate, account scaduto, limite connessioni o blocco paese/user-agent | Verifica le credenziali ricopiando l'URL dal pannello, controlla la scadenza dal provider, oppure prova con `output=ts` |

Con la build attuale entrambi i casi si sistemano **da soli al riavvio**: non devi toccare il volume.
Se resti su una build vecchia, i due comandi sopra risolvono immediatamente.

## 9. Note

* L'addon non ospita contenuti: converte liste pubbliche fornite dall'utente.
  Verifica di avere i diritti per usare le liste che importi.
* Se esponi la porta su Internet imposta `ADMIN_TOKEN` e/o il *token di accesso*
  nella pagina di configurazione.
* Le liste WisePlay cambiano spesso: se un gruppo sparisce usa *Aggiorna* nella sua scheda.
