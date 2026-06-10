#!/usr/bin/env bash
# Build the EdgeWorker bundle.
#
# Usage: bash build.sh
#
# Harper config is read from Akamai property variables at runtime — no secrets
# are injected into the bundle. See .env.example for the full variable list.
# Output: bundle.tgz (excluded from git by .gitignore)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

tar -czvf "$SCRIPT_DIR/bundle.tgz" \
  -C "$SCRIPT_DIR" \
  bundle.json main.js harper-client.js

echo ""
echo "bundle.tgz ready — upload via Akamai Control Center → EdgeWorkers → [your ID] → Create Version"
