#!/usr/bin/env bash
# dev.sh — one-command local dev for the Harper prerender pipeline.
#
#   ./dev.sh         Install deps, build + start the Docker stack, then run the
#                    demo UI on http://localhost:8090 (Ctrl+C stops the UI; the
#                    Docker stack keeps running).
#   ./dev.sh down    Stop the Docker stack.
#
# Env overrides: DEMO_PORT (default 8090).
#
# Prereqs: Docker Desktop (running) and Node 18+. See README "Run it locally".
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
DEMO_PORT="${DEMO_PORT:-8090}"

if [ "${1:-}" = "down" ]; then
	echo "Stopping the stack…"
	docker compose down
	exit 0
fi

# ── Prerequisites ─────────────────────────────────────────────────────────────
command -v docker >/dev/null || { echo "✗ Docker not found — install Docker Desktop: brew install --cask docker"; exit 1; }
command -v node   >/dev/null || { echo "✗ Node not found — install Node 18+: brew install node"; exit 1; }
docker info >/dev/null 2>&1   || { echo "✗ Docker daemon not running — launch Docker Desktop and retry."; exit 1; }

# ── Component deps (required before compose — HarperDB bind-mounts the folder) ──
if [ ! -d harper-prerender/node_modules ]; then
	echo "Installing harper-prerender deps…"
	(cd harper-prerender && npm install)
fi

# ── Start the stack ───────────────────────────────────────────────────────────
echo "Building & starting the stack (first run downloads Chrome — a few minutes)…"
docker compose up -d --build

printf "Waiting for HarperDB"
until curl -fsS -o /dev/null -u HDB_ADMIN:password http://localhost:9926/sitemaps/ 2>/dev/null; do printf "."; sleep 3; done
echo " ✔"

printf "Waiting for the renderer to register"
until docker compose logs renderer 2>/dev/null | grep -q "registered successfully"; do printf "."; sleep 3; done
echo " ✔"

# ── Demo UI deps + run ────────────────────────────────────────────────────────
if [ ! -d demo-ui/node_modules ]; then
	echo "Installing demo-ui deps…"
	(cd demo-ui && npm install)
fi

cat <<EOF

✔ Stack is up:
    HarperDB   http://localhost:9926   (app + MQTT-over-WS) · ops :9925 · mqtt :1883
    Origin     http://localhost:8080   (bundled CSR sample)
    Renderer   Puppeteer (in Docker)

Starting the demo UI → http://localhost:${DEMO_PORT}
  • Ctrl+C stops the UI; the Docker stack keeps running.
  • Stop everything with:  ./dev.sh down

EOF

cd demo-ui && PORT="$DEMO_PORT" exec node server.js
