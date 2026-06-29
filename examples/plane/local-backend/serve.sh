#!/usr/bin/env bash
# Production-style DURABLE local backend for the Plane benchmark.
#
# Why this exists: `npx convex dev` runs the convex-local-backend binary as a CHILD
# of a session-tied file watcher — close the terminal and the backend dies. That is
# fine for editing, wrong for "a production machine the package syncs against." This
# script runs the SAME binary standalone and SUPERVISED, so it survives the session
# and auto-restarts on crash. State is the exact on-disk sqlite + file storage that
# `convex dev` already created (.convex/local/default), so functions and data carry
# over with NO re-deploy. Deploy code changes with ./deploy.sh (no watcher needed).
#
# Cloud-free: --disable-beacon (never phones home). Prod-hardened: --redact-logs-to-client.
# Run durably:  nohup ./local-backend/serve.sh >/tmp/plane-backend-serve.log 2>&1 &
# Stop:         kill <this script's pid>   (the trap stops the backend child too)
set -euo pipefail

EXAMPLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$EXAMPLE_DIR/.convex/local/default"
CONFIG="$STATE_DIR/config.json"
LOG="${LOG:-/tmp/plane-local-backend.log}"

[ -f "$CONFIG" ] || { echo "no deployment at $CONFIG — run 'npx convex dev' once to provision it" >&2; exit 1; }

cfg() { node -e "process.stdout.write(String(require('$CONFIG').$1))"; }
PORT="$(cfg ports.cloud)"
SITE_PORT="$(cfg ports.site)"
INSTANCE_NAME="$(cfg deploymentName)"
INSTANCE_SECRET="$(cfg instanceSecret)"
BIN="$HOME/.cache/convex/binaries/$(cfg backendVersion)/convex-local-backend"

[ -x "$BIN" ] || { echo "backend binary not found at $BIN" >&2; exit 1; }

# Refuse to fight an existing backend on the port (e.g. a stray `convex dev`).
if lsof -ti:"$PORT" >/dev/null 2>&1; then
  echo "port $PORT already in use — stop the existing backend first: kill \$(lsof -ti:$PORT)" >&2
  exit 1
fi

child=""
cleanup() { [ -n "$child" ] && kill "$child" 2>/dev/null || true; exit 0; }
trap cleanup INT TERM

echo "serving $INSTANCE_NAME on :$PORT (site :$SITE_PORT) — backend log -> $LOG"
# Supervise: restart on crash with a short backoff. ponytail: a while-loop IS the
# supervisor; no systemd/pm2 for a local dev backend. Upgrade path: a launchd plist
# if it must survive reboots, not just the session.
backoff=1
while true; do
  "$BIN" \
    --port "$PORT" --site-proxy-port "$SITE_PORT" \
    --instance-name "$INSTANCE_NAME" --instance-secret "$INSTANCE_SECRET" \
    --local-storage "$STATE_DIR/convex_local_storage" \
    --disable-beacon --redact-logs-to-client \
    "$STATE_DIR/convex_local_backend.sqlite3" \
    >>"$LOG" 2>&1 &
  child=$!
  wait "$child" || true
  child=""
  echo "[serve.sh] backend exited; restarting in ${backoff}s" | tee -a "$LOG" >&2
  sleep "$backoff"
  backoff=$(( backoff < 10 ? backoff + 1 : 10 ))
done
