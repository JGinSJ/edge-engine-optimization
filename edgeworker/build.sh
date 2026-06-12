#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Building unified EdgeWorker bundle (Phase B)…"
tar -czvf "$SCRIPT_DIR/bundle.tgz" \
  -C "$SCRIPT_DIR" \
  bundle.json main.js harper-read.js harper-client.js crawler-policy.js demo-presets.js

echo ""
echo "Bundle created: $SCRIPT_DIR/bundle.tgz"
echo ""
echo "Next steps:"
echo "  1. Open Akamai Control Center → EdgeWorkers"
echo "  2. Select the unified EdgeWorker ID → Create Version"
echo "  3. Upload bundle.tgz"
echo "  4. Activate on Staging, then Production"
echo ""
echo "Each property selects its scenario via PMUSER_* (see demo/scenarios.config.json +"
echo "the Phase B spec). md-cache: HARPER_READ_MODE=markdown_cache, WRITE_THROUGH=true."
