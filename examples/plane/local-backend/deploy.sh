#!/usr/bin/env bash
# One-shot deploy of convex functions to the STANDALONE backend (no file watcher).
# This is the "push code to the production machine" step: `convex dev` couples deploy
# to a watcher; production deploys are one-shot. Uses the self-hosted admin key from
# the on-disk config — fully cloud-free, never contacts Convex cloud.
set -euo pipefail

EXAMPLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$EXAMPLE_DIR/.convex/local/default/config.json"
[ -f "$CONFIG" ] || { echo "no deployment config at $CONFIG" >&2; exit 1; }

cfg() { node -e "process.stdout.write(String(require('$CONFIG').$1))"; }
URL="http://127.0.0.1:$(cfg ports.cloud)"
KEY="$(cfg adminKey)"

cd "$EXAMPLE_DIR"
echo "deploying functions to $URL (self-hosted, cloud-free)"
# CONVEX_DEPLOYMENT (from .env.local, used by `convex dev`) is mutually exclusive
# with the self-hosted vars — empty it here so the CLI targets our standalone backend.
# (dotenv won't override an already-set var; "" reads as unset to the CLI.)
CONVEX_DEPLOYMENT= CONVEX_SELF_HOSTED_URL="$URL" CONVEX_SELF_HOSTED_ADMIN_KEY="$KEY" \
  npx convex deploy --yes </dev/null
