#!/bin/sh
# Starts as root (needed to fix bind mounts), then drops privileges to the
# "app" user. Solves the two typical problems when mounting a host folder:
#
#  1) EISDIR  -> on first start Docker auto-creates "config.json" as a DIRECTORY
#                if the path does not exist on the host: we remove it (if empty)
#                or move it, so the app can create it as a file.
#  2) EACCES  -> bind mounts inherit host ownership (often root):
#                we chown the data folder before starting the app.

CFG="${CONFIG_FILE:-/data/config.json}"
CACHEDIR="${CACHE_DIR:-/data/cache}"

# RAM diet: --expose-gc lets the server release unused heap periodically
# (see the GC timer in the scene); the user can override or extend
# everything with NODE_OPTIONS (e.g. also --max-old-space-size)
export NODE_OPTIONS="--expose-gc ${NODE_OPTIONS}"

if [ -d "$CFG" ]; then
  echo "[entrypoint] $CFG is a directory (auto-created by Docker): fixing it"
  rmdir "$CFG" 2>/dev/null || mv "$CFG" "${CFG}.autodir-backup" 2>/dev/null || \
    echo "[entrypoint] warning: cannot remove $CFG, the app will report it"
fi

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$(dirname "$CFG")" "$CACHEDIR" 2>/dev/null || true
  chown -R app:app "$(dirname "$CFG")" 2>/dev/null || true
  exec su-exec app:app "$@"
fi

exec "$@"
