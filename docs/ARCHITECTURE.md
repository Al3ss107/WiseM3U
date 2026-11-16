# Architettura

WiseM3U è un'applicazione Node.js/Express a processo singolo. Non usa un
database: la configurazione è un file JSON sul volume dati e le cache sono file
su disco (con alberi "caldi" in RAM).

## Struttura

```
src/
  server.js            composizione dell'app Express e rotte non modulari
  routes/
    history.js         cronologia: elenco, restore, checkpoint, undo
    trash.js           cestino: delete, elenco, restore, svuota
  config.js            lettura/scrittura atomica della config, normalizzazione, revisione
  history.js           snapshot su disco, diff per categorie, retention, checkpoint
  cache.js             snapshot gzip degli alberi + LRU in RAM
  wiseplay.js          download/parsing WisePlay, M3U e M3U_PLUS
  playlist.js          flatten, cataloghi Stremio/Nuvio, M3U finale, liste personali
  m3u.js               parser e builder M3U
  selection.js         selezione dei rami (esclusioni, keyword)
  protocols.js         riconoscimento protocolli e URL
  imgfit.js            riproporzionamento dei loghi
  streamdiag.js        diagnostica degli stream (opt-in)
  xtream.js            info account Xtream
  liveLog.js           buffer circolare dei log live
  constants.js         versione (da package.json), UA, timeout, limiti
public/
  configure.html       markup della pagina di configurazione
  configure.css        stili (Material 3, tema scuro)
  configure.js         logica della pagina (vanilla JS, nessun build step)
  manifest.json, logo.svg, ...
tests/                 suite di regressione eseguite con `npm test`
```

## Flusso di una richiesta

1. `src/server.js` monta `express.json` (limite 4 MB), la compressione e i file
   statici di `public/`.
2. Le rotte pubbliche (`/manifest.json`, `/catalog`, `/playlist.m3u`, stream,
   immagini) usano `requireToken`; le rotte `/api/*` usano `requireAdmin`.
3. Le rotte della cronologia e del cestino sono `express.Router()` in
   `src/routes/`, montati rispettivamente su `/api/history` e `/api/lists`.
   Ricevono solo il middleware `admin`: le dipendenze (config, cache, history,
   playlist) sono importate direttamente, così i moduli restano testabili.
4. La pagina `/configure` viene servita da `configPageHtml()`: il server
   sostituisce l'unico placeholder `__WM_UI_VERSION__` nella meta tag
   `wm-ui-version`. CSS e JS sono file separati serviti staticamente e
   `configure.js` legge la versione dalla meta (niente versioni hardcoded).
5. Ogni modifica "stabile" della configurazione passa da `config.saveConfig`,
   che incrementa `rev` e registra uno snapshot in `history` (lo stato runtime
   delle liste è escluso dal confronto). Un `PUT /api/config` con `baseRev`
   vecchia riceve **409** e lo stato corrente.

## Convenzioni

- **Errori API**: `{ error: "messaggio in italiano" }`, status coerente
  (400 input non valido, 401 token, 404 non trovato, 409 conflitto/stato non
  pronto, 500 errore interno).
- **Config**: mai scrivere direttamente il file; usare `store.saveConfig`. I
  campi derivati o obsoleti vengono normalizzati in `normalizeConfig`.
- **Cronologia**: ciò che è "stabile" va in `stableConfig`; i cambi di stato
  (`status`, `stats`, `fetchedAt`) non devono creare snapshot.
- **UI**: tutto il testo utente passa da `esc()` prima di finire in `innerHTML`;
  nessun framework, nessun build step.
- **Segreti**: URL con credenziali e token restano sul volume dati; la UI mostra
  gli URL redatti e le API sono protette da `ADMIN_TOKEN`.

## Test

`npm test` esegue in sequenza le suite Node (log, diagnostica, Xtream,
WisePlay, imgfit, cronologia/API). Le suite avviano un server reale su una
porta locale e un volume dati temporaneo, quindi verificano anche le rotte e
gli asset della pagina di configurazione.
