#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Building EdgeWorker bundle…"
tar -czvf "$SCRIPT_DIR/bundle.tgz" \
  -C "$SCRIPT_DIR" \
  bundle.json main.js harper-cache-client.js

echo ""
echo "Bundle created: $SCRIPT_DIR/bundle.tgz"
echo ""
echo "Next steps:"
echo "  1. Open Akamai Control Center → EdgeWorkers"
echo "  2. Select your EdgeWorker ID → Create Version"
echo "  3. Upload bundle.tgz"
echo "  4. Activate on Staging, then Production"
