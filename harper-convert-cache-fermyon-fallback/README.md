# Serverless AI-SEO Pipeline

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
3. **Harper cache lookup** *(when `HARPER_ENABLED=true`)* — The EdgeWorker calls Harper Markdown Prerender's `/page_content` endpoint. On a cache hit, Harper returns pre-converted Markdown (gzip-compressed) and the EdgeWorker streams it directly to the client with `X-Served-By: harper-cache`. No Wasm execution needed.
4. **Fermyon fallback** — On any Harper failure (timeout, 5xx, wrong content-type, network error) or when `HARPER_ENABLED=false`, the EdgeWorker calls the Fermyon Spin Wasm function, which fetches the target URL, converts HTML to Markdown using the `html2md` crate, and preserves JSON-LD Schema markup.
5. **Response** — Markdown is returned to the client with `Content-Type: text/markdown; charset=utf-8` and `Cache-Control: max-age=3600, public`.

---

## Production Deployment

This POC is live at **https://nobodycaresworkharder.me**.

| Component | Implementation |
|---|---|
| Domain registrar / DNS | GoDaddy (apex A records → Akamai edge IPs; `www` CNAME → Akamai edge hostname) |
| CDN / edge logic | Akamai property (Dynamic Site Accelerator) |
| EdgeWorker | `edgeworker-orchestrator/` — traffic gatekeeper and Harper/Fermyon orchestrator |
| Origin | Akamai Object Storage bucket (static website hosting, `us-ord-1` region) |
| TLS | Akamai CPS Enhanced TLS, SAN cert covering apex + www |
| Compute | Fermyon Spin Wasm function (`akamai-ai-markdown/`) |

The Akamai property has a single `AI Bot Interception` child rule under the Default Rule. It matches on the `X-Verified-Bot: true` request header and invokes the EdgeWorker with Continue-on-Error enabled — a runtime failure falls through to the origin instead of returning a 500.

---

## Repository Structure

```
serverless-ai-seo-pipeline/
├── edgeworker-orchestrator/
│   ├── main.js               # Akamai EdgeWorker — traffic gatekeeper and Harper/Fermyon orchestrator
│   ├── harper-client.js      # Harper /page_content client module
│   ├── harper-client.test.js # Unit tests (node:test, 13 cases)
│   └── bundle.json           # EdgeWorker manifest
├── akamai-ai-markdown/
│   ├── src/lib.rs       # Rust/Wasm HTTP component — fetches HTML, returns Markdown
│   ├── Cargo.toml       # spin-sdk v5, html2md 0.2
│   └── spin.toml        # Fermyon Spin manifest v2
├── docs/
│   └── integrations/
│       └── harper-integration-spec.md  # Harper API reference and integration notes
├── scripts/
│   ├── harper-bulk-upload.js  # Cache pre-population (sitemap + URL list modes)
│   └── mock-harper-server.js  # Local mock Harper server for end-to-end verification
├── demo-page/
│   └── index.html       # WorkHarder — deliberately bloated B2B SaaS demo page
├── demo-ui/
│   ├── fixtures/        # Pre-saved enterprise HTML (Tier 1 Telco, Cloud CRM) for token comparison
│   ├── fixtures.json    # Customer/page index for the UI's selector
│   ├── server.js        # Node.js demo server
│   └── package.json     # Dependencies: tiktoken, turndown
├── .env.example         # Harper env var reference (documentation only — see note inside)
├── package.json         # Root test harness (node:test)
└── validate-edge-seo.sh # Retired staging validation script
```

---

## Running the Demo

### 1. Unlock the origin bucket

The origin bucket is locked when not in use so the fixture HTML isn't publicly accessible. Open it before running the demo:

```bash
demo-unlock      # uses the ~/.zshrc alias defined in Setup below
demo-check       # should return: HTTP/1.1 200 OK
```

### 2. Run the demo UI

```bash
cd demo-ui
node server.js
```

Open the URL printed in the console. The UI presents five demo pages (Tier 1 Telco iPhone 17 Pro Max, Tier 1 Telco Wireless Plans, Cloud CRM Agentforce, Cloud CRM Sales Cloud Pricing, WorkHarder Homepage). Each runs three scenarios in parallel:

- **Scenario A — Human Visitor.** Standard browser request. Served HTML from the Linode origin via Akamai. EdgeWorker does not run.
- **Scenario B — AI Crawler, First Visit.** `X-Verified-Bot: true` header triggers the EdgeWorker, which calls the Wasm function. Returns clean Markdown with token counts measured live.
- **Scenario C — AI Crawler, Returns.** Same bot request. On a cache hit, Akamai serves the Markdown directly from the CDN without re-running the Wasm function.

The UI surfaces three business-oriented metrics per page:

- **Edge Processing Time** — wall-clock latency from request to Markdown response
- **Leaner Content for AI** — cl100k_base token reduction ratio (e.g. 189.8× for the Tier 1 Telco iPhone page, 22.7× for the Cloud CRM page)
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
alias demo-check='curl -sI http://serverless-ai-seo-pipeline.website-us-ord-1.linodeobjects.com/index.html | head -1'
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

### Rebuilding the Wasm component (only if changing Rust code)

```bash
cd akamai-ai-markdown
spin build
spin deploy
```

### Updating the EdgeWorker (only if changing main.js or harper-client.js)

Harper configuration is read from Akamai property variables at runtime — no secrets are injected at build time.

```bash
# 1. Build the bundle
cd edgeworker-orchestrator
bash build.sh

# 2. Upload bundle.tgz via Akamai Control Center → EdgeWorkers → [your EdgeWorker ID] → Create Version
#    Activate on Staging, test, then activate on Production
```

---

## Fixtures and Origin Hosting

The four enterprise fixture pages are saved snapshots of real enterprise pages, uploaded to the same Linode bucket that serves the WorkHarder demo origin. The Wasm function fetches them through the Akamai edge during demos rather than reaching out to the live origins directly.

This means demos:

- Don't generate unexpected traffic to live customer origins
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

## Harper Markdown Prerender

Harper is a HarperDB component that pre-converts origin HTML to Markdown and caches it. When enabled, the EdgeWorker calls Harper first and streams its gzip-compressed Markdown response directly to the bot — no Wasm execution, no truncation. Fermyon remains the on-demand fallback.

Full API reference: `docs/integrations/harper-integration-spec.md`

### Enable Harper

Harper configuration lives in Akamai Control Center as property variables — secrets never appear in source code.

1. Obtain `HARPER_URL` and `HARPER_TOKEN` from the Harper team.
2. In Akamai Control Center → Property Manager → your property → **Property Variables**, add:

   | Variable name | Value | Mark sensitive? |
   |---|---|---|
   | `PMUSER_HARPER_ENABLED` | `true` | no |
   | `PMUSER_HARPER_URL` | `https://your-instance.harperdbcloud.com` | no |
   | `PMUSER_HARPER_TOKEN` | `your-token-here` | **yes** |
   | `PMUSER_HARPER_TIMEOUT_MS` | `1500` | no |

   Mark `PMUSER_HARPER_TOKEN` as **Sensitive** so it is masked in logs and not returned by the metadata API.

3. Bundle and deploy:
   ```bash
   cd edgeworker-orchestrator
   bash build.sh
   ```
4. Upload the bundle in Control Center and activate. The `responseProvider` event handler may require updating the EdgeWorker invocation behavior on the `AI Bot Interception` child rule — verify on Staging before activating on Production.

### Pre-populate the cache

Run the bulk-upload script before deploying or before a demo so Harper has content ready on first bot visit:

```bash
# Sitemap mode (recommended)
HARPER_URL=https://... HARPER_TOKEN=... \
  node scripts/harper-bulk-upload.js \
  --sitemap https://nobodycaresworkharder.me/sitemap.xml

# URL list mode
HARPER_URL=https://... HARPER_TOKEN=... \
  node scripts/harper-bulk-upload.js \
  --urls https://nobodycaresworkharder.me/ \
         https://nobodycaresworkharder.me/telco-iPhone-17-Pro-Max.html

# Dry run — print request body without sending
HARPER_URL=https://... HARPER_TOKEN=... \
  node scripts/harper-bulk-upload.js --sitemap https://... --dry-run
```

### Verify locally with the mock server

```bash
node scripts/mock-harper-server.js   # starts on port 4000

# Cache-hit path — should return 200 + Content-Encoding: gzip + X-Served-By: harper-cache
curl -s -i -H "Authorization: Basic dGVzdDp0ZXN0" \
  "http://localhost:4000/page_content?path=https://example.com"

# Fallback path — should return 503 to trigger Fermyon fallback in the EdgeWorker
curl -s -i -H "Authorization: Basic dGVzdDp0ZXN0" \
  "http://localhost:4000/page_content?path=https://example.com&scenario=http-error"
```

Available mock scenarios: `success`, `http-error`, `wrong-content-type`, `retry-after`, `timeout`, `network-error`.

### Disable Harper (rollback)

Set `PMUSER_HARPER_ENABLED` to `false` in Akamai Control Center → Property Manager → Property Variables and activate the updated property. No EdgeWorker redeployment is needed. With the flag off, the pipeline behaves identically to before Harper was added — Fermyon handles all bot traffic, no Harper calls are made, and no observability headers are added.

### Run the test suite

```bash
npm test   # 13 unit tests — node:test, no install required
```

---

## Honest Limitations

This is a POC, not a production-grade product. When demoing to customers, be transparent about these points:

1. **No edge cache on returning bots (without Harper).** With `HARPER_ENABLED=false`, the Wasm function runs on every bot request — Akamai does not cache `responseProvider` responses automatically without additional property configuration. With Harper enabled, responses are served from Harper's pre-populated cache, making this a non-issue for the Harper path.

2. **No real bot verification.** The pipeline triggers on the `X-Verified-Bot: true` request header, which any client can spoof. In a production deployment, Akamai Bot Manager (separately licensed) sets that header only for cryptographically verified crawlers (GPTBot, ClaudeBot, etc.). The POC demo simulates this by sending the header directly from the demo UI.

---

## Validation

For a quick end-to-end smoke test without the demo UI:

```bash
# Human request — should return text/html
curl -sI https://nobodycaresworkharder.me/ \
  | grep -iE "^HTTP|content-type"

# Bot request (homepage) — should return text/markdown + x-wasm-execution: success or x-served-by: harper-cache
curl -sI -H "X-Verified-Bot: true" https://nobodycaresworkharder.me/ \
  | grep -iE "^HTTP|content-type|x-wasm|x-served-by"

# Bot request for a specific fixture page — ?url= is required because the Akamai property
# rewrites all paths to / before the EdgeWorker runs; the EdgeWorker reads the target URL
# from the query parameter instead.
curl -sI -H "X-Verified-Bot: true" \
  "https://nobodycaresworkharder.me/?url=https%3A%2F%2Fnobodycaresworkharder.me%2Ftelco-iPhone-17-Pro-Max.html" \
  | grep -iE "^HTTP|content-type|x-wasm|x-served-by"
```

The `validate-edge-seo.sh` script targeted an older staging property and is no longer used — the demo UI runs exclusively against production.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
