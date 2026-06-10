#!/usr/bin/env bash
# demo-prep.sh — Serverless AI-SEO Pipeline pre-demo smoke test
# Usage: bash demo-prep.sh
# Exits 0 if all checks pass, non-zero if any fail.
# Run this ~10 min before a customer call.

set -uo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────
DOMAIN="stopwaitingshipit.com"
BUCKET_ORIGIN="http://serverless-ai-seo-pipeline.website-us-ord-1.linodeobjects.com"
WASM_URL="https://bede2402-c4b7-4234-b17c-5e04fc46ef00.fwf.app"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES_JSON="$SCRIPT_DIR/demo-ui/fixtures.json"
FIXTURES_DIR="$SCRIPT_DIR/demo-ui/fixtures"

# GoDaddy parking CIDR prefixes (domain parked → wrong place)
PARKING_PREFIXES=("184.168." "208.109.")

# Expected fixture entries — edit this list if you change fixtures.json
# Format: "Customer / Label"
EXPECTED_FIXTURES=(
  "Tier 1 Telco / iPhone 17 Pro Max"
  "Tier 1 Telco / Wireless Plans"
  "WorkHarder / Homepage"
  "Cloud CRM / Agentforce"
  "Cloud CRM / Sales Cloud Pricing"
)

PASS=0
FAIL=0

# ─── Helpers ─────────────────────────────────────────────────────────────────
ok()      { printf "  ✅  %s\n" "$*";         PASS=$((PASS + 1)); }
fail()    { printf "  ❌  %s\n" "$1";
            printf "     ↳  %s\n" "$2";       FAIL=$((FAIL + 1)); }
section() { printf "\n── %s ──\n" "$1"; }
info()    { printf "  ℹ️   %s\n" "$*"; }

printf "\n╔══════════════════════════════════════════════════════╗\n"
printf "║        Edge AI Markdown — Pre-Demo Smoke Test        ║\n"
printf "╚══════════════════════════════════════════════════════╝\n"

# ─── 1. LOCAL ENVIRONMENT ────────────────────────────────────────────────────
section "Local environment"

# Node.js >= 18
if command -v node &>/dev/null; then
  NODE_VER=$(node --version)
  NODE_MAJOR=$(echo "$NODE_VER" | sed 's/v//' | cut -d. -f1)
  if [[ "$NODE_MAJOR" -ge 18 ]]; then
    ok "Node.js $NODE_VER"
  else
    fail "Node.js $NODE_VER is too old (need >= 18)" \
         "Run: nvm use 18   or   brew upgrade node"
  fi
else
  fail "node not found" \
       "Install Node.js >= 18 from nodejs.org"
fi

# curl present
if command -v curl &>/dev/null; then
  ok "curl $(curl --version | head -1 | awk '{print $2}')"
else
  fail "curl not found" "Install curl: brew install curl"
fi

# python3 present (used for JSON parsing)
if ! command -v python3 &>/dev/null; then
  fail "python3 not found (needed for fixtures.json parsing)" \
       "Install: brew install python3"
fi

# ─── 2. FIXTURES.JSON ────────────────────────────────────────────────────────
section "fixtures.json"

if [[ ! -f "$FIXTURES_JSON" ]]; then
  fail "fixtures.json not found at $FIXTURES_JSON" \
       "Are you running from the repo root? cd edge-ai-markdown && bash demo-prep.sh"
else
  # Valid JSON?
  if python3 -c "import json, sys; json.load(open(sys.argv[1]))" "$FIXTURES_JSON" 2>/dev/null; then
    ok "fixtures.json is valid JSON"
  else
    fail "fixtures.json is malformed" \
         "Run: python3 -m json.tool demo-ui/fixtures.json to see the parse error"
  fi

  # Parse and validate fixture file existence + print inventory
  section "Fixture inventory"
  FIXTURE_ERRORS=0
  while IFS= read -r line; do
    echo "$line"
    if [[ "$line" == *"MISSING"* ]]; then
      FIXTURE_ERRORS=$((FIXTURE_ERRORS + 1))
    fi
  done < <(python3 - "$FIXTURES_JSON" "$FIXTURES_DIR" <<'PYEOF'
import json, os, sys

fixtures_json = sys.argv[1]
fixtures_dir  = sys.argv[2]

with open(fixtures_json) as f:
    data = json.load(f)

for customer in data.get("customers", []):
    for page in customer.get("pages", []):
        name  = customer["name"]
        label = page["label"]
        ffile  = page.get("file")
        if ffile is None:
            print(f"  📄  {name} / {label}  (live URL — no fixture file)")
        else:
            path = os.path.join(fixtures_dir, ffile)
            if os.path.exists(path):
                size_kb = os.path.getsize(path) // 1024
                print(f"  📄  {name} / {label}  → {ffile}  ({size_kb} KB)")
            else:
                print(f"  MISSING  {name} / {label}  → {ffile}")
PYEOF
)

  if [[ "$FIXTURE_ERRORS" -eq 0 ]]; then
    ok "All fixture files present on disk"
  else
    fail "$FIXTURE_ERRORS fixture file(s) missing from demo-ui/fixtures/" \
         "Run: ls demo-ui/fixtures/ — re-upload missing files to the bucket and re-download"
  fi

  # Cross-check against expected inventory
  section "Expected fixture inventory check"
  ACTUAL_LABELS=$(python3 - "$FIXTURES_JSON" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
for c in data.get("customers", []):
    for p in c.get("pages", []):
        print(f"{c['name']} / {p['label']}")
PYEOF
)
  ALL_PRESENT=true
  for expected in "${EXPECTED_FIXTURES[@]}"; do
    if echo "$ACTUAL_LABELS" | grep -qF "$expected"; then
      ok "Found: $expected"
    else
      fail "Missing from fixtures.json: $expected" \
           "Add it back to demo-ui/fixtures.json or update EXPECTED_FIXTURES in this script"
      ALL_PRESENT=false
    fi
  done
fi

# ─── 3. DNS ──────────────────────────────────────────────────────────────────
section "DNS — $DOMAIN"

if command -v dig &>/dev/null; then
  RESOLVED_IPS=$(dig +short A "$DOMAIN" 2>/dev/null | grep -E '^[0-9]')
else
  # Fallback: extract IP from curl's verbose output
  RESOLVED_IPS=$(curl -sv --max-time 5 "https://$DOMAIN/" 2>&1 \
    | grep "Connected to" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1)
fi

if [[ -z "$RESOLVED_IPS" ]]; then
  fail "$DOMAIN does not resolve" \
       "Check GoDaddy DNS — apex A records may have been cleared or TTL is propagating"
else
  PARKED=false
  for ip in $RESOLVED_IPS; do
    for prefix in "${PARKING_PREFIXES[@]}"; do
      if [[ "$ip" == "$prefix"* ]]; then
        fail "DNS resolves to GoDaddy parking IP: $ip" \
             "Re-point apex A records to Akamai edge IPs in GoDaddy DNS"
        PARKED=true
      fi
    done
  done
  if [[ "$PARKED" == false ]]; then
    ok "DNS resolves: $(echo "$RESOLVED_IPS" | tr '\n' ' ')"
  fi
fi

# ─── 4. APEX — HUMAN TRAFFIC ─────────────────────────────────────────────────
section "Apex — human traffic (Scenario A)"

APEX_RESPONSE=$(curl -sI --max-time 10 "https://$DOMAIN/" 2>/dev/null)
APEX_STATUS=$(echo "$APEX_RESPONSE" | grep -E "^HTTP" | awk '{print $2}' | tail -1)
APEX_CT=$(echo "$APEX_RESPONSE" | grep -i "^content-type:" | tr -d '\r' | awk '{print $2}')

if [[ "$APEX_STATUS" == "200" ]]; then
  ok "https://$DOMAIN/ → HTTP $APEX_STATUS"
else
  fail "https://$DOMAIN/ → HTTP ${APEX_STATUS:-no response}" \
       "Check Akamai property status and Linode origin — may be 403 if bucket is locked"
fi

if [[ "$APEX_CT" == text/html* ]]; then
  ok "Content-Type: $APEX_CT (human traffic passes through as HTML)"
else
  fail "Content-Type: ${APEX_CT:-missing} (expected text/html)" \
       "EdgeWorker may be firing on non-bot traffic — check property rule conditions"
fi

# ─── 5. BOT PIPELINE — FIRST VISIT ──────────────────────────────────────────
section "Bot pipeline — AI crawler first visit (Scenario B)"

BOT_RESPONSE=$(curl -sI --max-time 15 \
  -H "X-Verified-Bot: true" \
  "https://$DOMAIN/" 2>/dev/null)
BOT_STATUS=$(echo "$BOT_RESPONSE" | grep -E "^HTTP" | awk '{print $2}' | tail -1)
BOT_CT=$(echo "$BOT_RESPONSE" | grep -i "^content-type:" | tr -d '\r' | awk '{print $2}')
BOT_WASM=$(echo "$BOT_RESPONSE" | grep -i "^x-wasm-execution:" | tr -d '\r' | awk '{print $2}')

if [[ "$BOT_STATUS" == "200" ]]; then
  ok "Bot request → HTTP $BOT_STATUS"
else
  fail "Bot request → HTTP ${BOT_STATUS:-no response}" \
       "EdgeWorker or Wasm function failed — check Fermyon dashboard and EdgeWorker logs"
fi

if [[ "$BOT_CT" == text/markdown* ]]; then
  ok "Content-Type: $BOT_CT ✓"
else
  fail "Content-Type: ${BOT_CT:-missing} (expected text/markdown)" \
       "Wasm function may have returned an error or bucket is locked"
fi

if [[ "$BOT_WASM" == "success" ]]; then
  ok "x-wasm-execution: success ✓"
else
  fail "x-wasm-execution: ${BOT_WASM:-missing} (expected 'success')" \
       "EdgeWorker fired but Wasm execution failed — redeploy: cd akamai-ai-markdown && spin build && spin deploy"
fi

# ─── 6. ORIGIN BUCKET — FIXTURE URLS ────────────────────────────────────────
section "Origin bucket — fixture URLs (catches forgotten demo-lock)"

BUCKET_FIXTURE_PATHS=(
  "telco-iPhone-17-Pro-Max.html"
  "telco-plans-wireless.html"
  "cloud-crm-agentforce.html"
  "cloud-crm-sales-cloud-pricing.html"
  "index.html"
)

for path in "${BUCKET_FIXTURE_PATHS[@]}"; do
  URL="$BUCKET_ORIGIN/$path"
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 8 "$URL" 2>/dev/null)
  if [[ "$STATUS" == "200" ]]; then
    ok "Bucket: $path → $STATUS"
  elif [[ "$STATUS" == "403" ]]; then
    fail "Bucket: $path → 403 (bucket is LOCKED)" \
         "Run: demo-unlock   then re-run this script"
  else
    fail "Bucket: $path → ${STATUS:-timeout}" \
         "Check Linode Object Storage status — bucket may be unavailable"
  fi
done

# ─── 7. WASM FUNCTION — FERMYON REACHABILITY ─────────────────────────────────
section "Wasm function — Fermyon endpoint"

WASM_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  -H "X-Target-URL: https://$DOMAIN/" \
  "$WASM_URL" 2>/dev/null)

if [[ "$WASM_STATUS" == "200" ]]; then
  ok "Fermyon Wasm function reachable → HTTP $WASM_STATUS"
elif [[ "$WASM_STATUS" == "4"* ]]; then
  # 4xx likely means endpoint is up but request shape is off — function is alive
  ok "Fermyon endpoint reachable (HTTP $WASM_STATUS — function is live)"
elif [[ -z "$WASM_STATUS" || "$WASM_STATUS" == "000" ]]; then
  fail "Fermyon endpoint timed out or unreachable" \
       "Check https://cloud.fermyon.com — redeploy: cd akamai-ai-markdown && spin deploy"
else
  fail "Fermyon endpoint → HTTP $WASM_STATUS" \
       "Check Fermyon dashboard for function errors or rate limits"
fi

# ─── SUMMARY ─────────────────────────────────────────────────────────────────
printf "\n══════════════════════════════════════════════════════\n"
TOTAL=$((PASS + FAIL))
if [[ "$FAIL" -eq 0 ]]; then
  printf "  ✅  All %d checks passed — you're good to demo.\n" "$TOTAL"
  printf "  📋  Remember: demo-unlock (if not done), then AKAMAI_TARGET=production node demo-ui/server.js\n"
  printf "══════════════════════════════════════════════════════\n\n"
  exit 0
else
  printf "  ❌  %d of %d checks FAILED — fix before the call.\n" "$FAIL" "$TOTAL"
  printf "══════════════════════════════════════════════════════\n\n"
  exit 1
fi
