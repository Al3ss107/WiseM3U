#!/bin/sh
# Entra come root (necessario per sistemare i bind-mount), poi cede i
# privilegi all'utente "app". Risolve i due problemi tipici di chi monta
# una cartella dell'host:
#
#  1) EISDIR  -> al primo avvio Docker autocrea "config.json" come DIRECTORY
#                se il path non esiste sull'host: la rimuoviamo (se vuota)
#                o la spostiamo, cosi' l'app puo' crearla come file.
#  2) EACCES  -> i bind-mount ereditano l'ownership dell'host (spesso root):
#                facciamo chown sulla cartella dati prima di avviare l'app.

CFG="${CONFIG_FILE:-/data/config.json}"
CACHEDIR="${CACHE_DIR:-/data/cache}"

if [ -d "$CFG" ]; then
  echo "[entrypoint] $CFG e' una directory (autocreatata da Docker): la sistemo"
  rmdir "$CFG" 2>/dev/null || mv "$CFG" "${CFG}.autodir-backup" 2>/dev/null || \
    echo "[entrypoint] attenzione: non riesco a rimuovere $CFG, l'app lo segnalerà"
fi

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$(dirname "$CFG")" "$CACHEDIR" 2>/dev/null || true
  chown -R app:app "$(dirname "$CFG")" 2>/dev/null || true
  exec su-exec app:app "$@"
fi

exec "$@"
