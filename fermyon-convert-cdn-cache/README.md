# Edge AI Markdown

A proof-of-concept Edge-native architecture that intercepts AI crawler traffic, converts HTML pages into structured Markdown, and serves the result at the edge — without touching origin code.

Built on Akamai EdgeWorkers and WebAssembly (via Fermyon Spin), with Akamai Object Storage as the origin.

---

## The Problem

As search traffic shifts toward AI-driven models (ChatGPT, Perplexity, Claude, OpenAI Searchbot), LLMs require clean, structured data. Parsing standard HTML laden with CSS and layout markup is inefficient for these crawlers — consuming significantly more tokens than plain text equivalents.

Implementing content negotiation at the origin is the obvious fix, but it depends on IT sprint cycles and origin code changes — options most marketing and SEO teams cannot control.

---

## The Solution

This pipeline intercepts AI bot requests at the Akamai edge and handles the HTML-to-Markdown conversion in a serverless, stateless WebAssembly module. Human traffic is never affected.

**Request flow:**

1. **Traffic segregation** — The EdgeWorker inspects each incoming request. Anything without an `X-Verified-Bot: true` header or `Accept: text/markdown` passes through to the origin unchanged.
2. **Target URL derivation** — For verified bot traffic, the EdgeWorker derives the target URL: it uses a `?url=<encoded-url>` query parameter if provided (demo mode), otherwise falls back to the request's Host + Path (production bot traffic mode).
3. **Compute handoff** — The EdgeWorker calls an Akamai Functions endpoint running a Rust/Wasm module via Fermyon Spin. The module fetches the target URL, converts HTML to Markdown using the `html2md` crate, and preserves JSON-LD Schema markup.
4. **Response** — Markdown is returned to the client with `Content-Type: text/markdown; charset=utf-8` and `Cache-Control: max-age=3600, public`.

---

## Production Deployment

This POC is live at **https://stopwaitingshipit.com**.

| Component | Implementation |
|---|---|
| Domain registrar / DNS | GoDaddy (apex A records → Akamai edge IPs; `www` CNAME → `stopwaitingshipit.com.edgekey.net`) |
| CDN / edge logic | Akamai property `stopwaitingshipit.com` (Dynamic Site Accelerator) |
| EdgeWorker | `edgeworker-orchestrator/` v1.1.0 (ID `108291`) — traffic gatekeeper |
| Origin | Linode Object Storage bucket `serverless-ai-seo-pipeline` (region `us-ord-1`, static website hosting) |
| TLS | Akamai CPS Enhanced TLS, SAN cert covering apex + www |
| Compute | Fermyon Spin Wasm function at `https://bede2402-c4b7-4234-b17c-5e04fc46ef00.fwf.app` |

The Akamai property has a single `AI Bot Interception` child rule under the Default Rule. It matches on the `X-Verified-Bot: true` request header and invokes the EdgeWorker with Continue-on-Error enabled — a runtime failure falls through to the origin instead of returning a 500.

---

## Repository Structure

```
edge-ai-markdown/
├── edgeworker-orchestrator/
│   ├── main.js          # Akamai EdgeWorker (v1.1.0) — traffic gatekeeper
│   └── bundle.json      # EdgeWorker manifest
├── akamai-ai-markdown/
│   ├── src/lib.rs       # Rust/Wasm HTTP component — fetches HTML, returns Markdown
│   ├── Cargo.toml       # spin-sdk v5, html2md 0.2
│   └── spin.toml        # Fermyon Spin manifest v2
├── demo-page/
│   └── index.html       # WorkHarder — deliberately bloated B2B SaaS demo page
├── demo-ui/
│   ├── fixtures/        # Pre-saved enterprise HTML (Tier 1 Telco, Cloud CRM) for token comparison
│   ├── fixtures.json    # Customer/page index for the UI's selector
│   ├── server.js        # Node.js demo server
│   └── package.json     # Dependencies: tiktoken, turndown
├── .env.example         # Environment variable template
└── demo-prep.sh         # Pre-demo smoke test script
```

---

## Running a Customer Demo

### 1. Unlock the origin bucket

The Linode bucket is locked between demos so the Tier 1 Telco/Cloud CRM fixture HTML isn't publicly accessible. Open it before running the demo:

```bash
demo-unlock      # uses the ~/.zshrc alias defined in Setup below
demo-check       # should return: HTTP/1.1 200 OK
```

### 2. Run the demo UI

```bash
cd demo-ui
AKAMAI_TARGET=production node server.js
```

Open the URL printed in the console. The UI presents five demo pages (Tier 1 Telco iPhone 17 Pro Max, Tier 1 Telco Wireless Plans, Cloud CRM Agentforce, Cloud CRM Sales Cloud Pricing, WorkHarder Homepage). Each runs three scenarios in parallel:

- **Scenario A — Human Visitor.** Standard browser request. Served HTML from the Linode origin via Akamai. EdgeWorker does not run.
- **Scenario B — AI Crawler, First Visit.** `X-Verified-Bot: true` header triggers the EdgeWorker, which calls the Wasm function. Returns clean Markdown with token counts measured live.
- **Scenario C — AI Crawler, Returns.** Same bot request again. Served as a CDN HIT from the Akamai cache — the Wasm function does not re-run.

The UI surfaces three business-oriented metrics per page:

- **Edge Processing Time** — wall-clock latency from request to Markdown response
- **Leaner Content for AI** — cl100k_base token reduction ratio (e.g. 189.8× for the Tier 1 Telco iPhone page, 22.7× for Cloud CRM Agentforce)
- **Pipeline Success Rate** — whether both bot scenarios returned `Content-Type: text/markdown`

### 3. Lock the bucket when done

```bash
demo-lock
demo-check       # should return: HTTP/1.1 403 Forbidden
```

---

## Setup (One-Time)

### Prerequisites

- [Akamai EdgeWorkers](https://techdocs.akamai.com/edgeworkers/docs) access (already provisioned for this property)
- [Fermyon Spin](https://developer.fermyon.com/spin/v3/install) (for rebuilding the Wasm component)
- Rust toolchain with `wasm32-wasip1` target: `rustup target add wasm32-wasip1`
- Node.js >= 18 (for the demo UI)
- `s3cmd` configured with Linode Object Storage credentials
- `curl`

### Demo bucket toggle aliases

Add these to `~/.zshrc` so you can lock/unlock the origin bucket between demos:

```bash
# WorkHarder demo bucket toggle
alias demo-lock='s3cmd setpolicy ~/.workharder/lockdown-policy.json s3://serverless-ai-seo-pipeline --host=us-ord-1.linodeobjects.com "--host-bucket=%(bucket)s.us-ord-1.linodeobjects.com" && echo "🔒 Bucket locked"'
alias demo-unlock='s3cmd delpolicy s3://serverless-ai-seo-pipeline --host=us-ord-1.linodeobjects.com "--host-bucket=%(bucket)s.us-ord-1.linodeobjects.com" && echo "🔓 Bucket open"'
alias demo-check='curl -sI https://stopwaitingshipit.com/ | head -1'
```

The lockdown policy file (`~/.workharder/lockdown-policy.json`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyAllPublicReads",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::serverless-ai-seo-pipeline/*"
    }
  ]
}
```

### Environment variables

The demo UI reads the Fermyon endpoint from the environment:

```bash
cp .env.example .env
# Edit .env and set WASM_URL to your Fermyon deployment URL
```

Then start the server as normal:

```bash
cd demo-ui
AKAMAI_TARGET=production node server.js
```

The EdgeWorker reads the same URL from an Akamai property variable. In Control Center → your property → Property Variables, add:

| Variable name | Value |
|---|---|
| `PMUSER_WASM_URL` | Your Fermyon deployment URL |

### Rebuilding the Wasm component (only if changing Rust code)

```bash
cd akamai-ai-markdown
spin build
spin deploy
```

### Updating the EdgeWorker (only if changing main.js)

```bash
cd edgeworker-orchestrator
tar -czvf bundle.tgz bundle.json main.js
# Upload via Akamai Control Center → EdgeWorkers → 108291 → Create Version
# Activate on Staging, test, then activate on Production
```

---

## Fixtures and Origin Hosting

The four enterprise fixture pages are saved snapshots of real customer pages, uploaded to the same Linode bucket that serves the WorkHarder demo origin. The Wasm function fetches them through the Akamai edge during demos rather than reaching out to their origins directly.

This means demos:

- Don't generate unexpected traffic to Tier 1 Telco or Cloud CRM origins
- Aren't subject to rate-limiting or 403s from those sites' bot protection
- Are fully self-contained: laptop → Akamai → Linode bucket

A `robots.txt` is deployed at the bucket root (`Disallow: /`) as a belt-and-suspenders measure against accidental indexing.

| Customer | Fixture | Token reduction |
|---|---|---|
| Tier 1 Telco | iPhone 17 Pro Max | ~190× |
| Tier 1 Telco | Wireless Plans | ~133× |
| Cloud CRM | Agentforce | ~23× |
| Cloud CRM | Sales Cloud Pricing | ~34× |
| WorkHarder | Homepage (synthetic origin) | varies |

To add a new fixture: save the HTML, upload it to the bucket with `s3cmd put --acl-public`, and add an entry to `demo-ui/fixtures.json`.

---

## Honest Limitations

This is a POC, not a production-grade product. When demoing to customers, be transparent about these points:

1. **No real bot verification.** The pipeline triggers on the `X-Verified-Bot: true` request header, which any client can spoof. In a production deployment, Akamai Bot Manager (separately licensed) sets that header only for cryptographically verified crawlers (GPTBot, ClaudeBot, etc.). The POC demo simulates this by sending the header directly from the demo UI.

2. **No pre-rendered cache.** Returning bot requests are served from the Akamai CDN cache (`Cache-Control: max-age=3600, public`) rather than a pre-populated store. The first request to any URL still runs the full Wasm pipeline; subsequent requests within the TTL are served as CDN HITs.

---

## Validation

For a quick end-to-end smoke test without the demo UI:

```bash
# Human request — should return text/html
curl -sI https://stopwaitingshipit.com/ \
  | grep -iE "^HTTP|content-type"

# Bot request — should return text/markdown + x-wasm-execution: success
curl -sI -H "X-Verified-Bot: true" https://stopwaitingshipit.com/ \
  | grep -iE "^HTTP|content-type|x-wasm"

# Bot request against a specific fixture
curl -sI -H "X-Verified-Bot: true" \
  https://stopwaitingshipit.com/telco-iPhone-17-Pro-Max.html \
  | grep -iE "^HTTP|content-type|x-wasm"
```

For staging, replace the hostname with `stopwaitingshipit.com.edgekey-staging.net` and add `-k` to skip certificate verification.
