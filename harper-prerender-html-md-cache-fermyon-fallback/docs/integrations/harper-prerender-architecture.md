# Harper HTML+Markdown Prerender — Architecture & Deployment

> **Note (monorepo):** in `edge-engine-optimization`, the EdgeWorker described below
> has been consolidated into the unified read-only EdgeWorker at the repo root
> (`../../../edgeworker/`). References to `edgeworker-orchestrator/` here describe the
> original standalone layout; the prerender **backend** (renderer + Harper component)
> is what now lives in this subdirectory.

This project extends the baseline `serverless-ai-seo-pipeline` to solve the
**client-side-rendering (CSR) gap**: a plain origin fetch of a JS-rendered page
returns an empty shell, so neither the baseline Harper markdown-prerender nor the
Fermyon Wasm fallback can produce useful content from it.

Here, a headless-Chrome renderer executes the page's JavaScript, the resulting
**full HTML is cached in Harper**, and **Markdown is derived from that same
rendered HTML**. One render yields both representations under a single cache
record.

---

## Request flow

```
                         AI crawler (Accept: text/markdown, or AI User-Agent)
Akamai edge  ───────────►  Harper  GET /page_content?path=URL   → gzip text/markdown
(EdgeWorker)                          │ miss / timeout / error
   │                                  └─► Fermyon Wasm (html2md)        [fallback]
   │
   └── human / SEO crawler ─────────►  Harper  GET /page/?url=URL&deviceType=…  → gzip text/html
                                          │ miss / timeout / error
                                          └─► origin fetch                  [fallback]
```

- **Classification** (`edgeworker-orchestrator/main.js`): a request goes to the
  Markdown path if it sends `Accept: text/markdown` **or** its User-Agent matches
  the AI-crawler list (`PMUSER_AI_CRAWLER_UAS`, default GPTBot / ClaudeBot /
  OAI-SearchBot / PerplexityBot / …). Everything else — humans and SEO crawlers
  like Googlebot — gets prerendered HTML.
- **Observability headers** on every response:
  `X-Served-By: harper-cache-html | harper-cache-md | fermyon-fallback | origin-fallback`,
  plus `X-Harper-Fallback-Reason` and `X-Harper-Debug-*` when a fallback fired.

---

## Components

### 1. Unified Harper component — `harper-prerender/`

Forked from Harper's [`template-static-prerender`](https://github.com/HarperFast/template-static-prerender)
(the orchestration + cache half), with Markdown derivation added.

| Piece | File | Change vs. upstream |
|---|---|---|
| Cache schema | `data/schema.graphql` → `PageCache` | Added `markdownContent: Blob` + `markdownLength: Int` alongside the existing HTML `content` blob |
| Markdown derivation | `src/util/markdown.js` | **New.** gunzip HTML → `node-html-markdown` → re-gzip; preserves JSON-LD as fenced blocks; best-effort (returns null on failure) |
| Write path (scheduled) | `localExtensions/orchestrator/orchestrator.js` → `savePageContent` | Buffers the rendered HTML once, derives Markdown, stores both on the cache record; forwards the buffer to the on-demand callback |
| Write path (on-demand) | `src/resources/PageCache.js` → `pageSource.get` | Derives Markdown from the same rendered HTML and returns it on the record |
| HTML delivery | `src/resources/index.js` (`/page` handler) | Upstream, unchanged |
| **Markdown delivery** | `src/resources/index.js` (`/page_content` handler) | **New.** Serves `markdownContent` as `text/markdown`; 503 on miss so the edge falls back to Fermyon |
| Submission | `src/resources/Sitemap.js` (`POST /sitemaps`) | Upstream — queues URLs/sitemaps for rendering per device type |

Two upstream bugs were fixed while vendoring: `JobQueue.js` imported
`../RenderWorkers.js` and `../util/headers.js` (correct paths:
`../util/RenderWorkers.js`, `../util/header.js`).

**One render → one cache record → two representations**, keyed by
`{url|deviceType|acceptLanguage}` (see `src/util/CacheKey.js`). HTML and Markdown
share a single refresh/eviction lifecycle.

### 2. Headless renderer — `renderer/`

Forked from `template-static-prerender/renderer`, unchanged rendering logic
(Puppeteer / `chrome-headless-shell`). It claims jobs from Harper over HTTP,
subscribes to queue status over MQTT-via-WebSocket, renders the URL (executing
JS, stripping `<script>`, normalizing `<base>`), gzips the HTML, and POSTs it to
`/render_jobs/result`. The component then derives + stores Markdown.

The renderer Dockerfile was fixed to `npm ci && npm run build && npm prune
--omit=dev` (upstream used `--only=production`, which omitted the `typescript`
devDependency the build needs).

#### Rendering client-side SPAs (wait strategy)

Navigating to `load` snapshots a heavily client-rendered SPA *before* it hydrates
— you cache an empty shell. The renderer therefore navigates to
`domcontentloaded` (fast, always resolves) and then performs a **bounded,
non-throwing** `waitForNetworkIdle` so a hydrating app has time to paint, without
failing renders on pages that beacon forever (analytics, chat widgets). Tunable:

| Env | Default | Meaning |
|---|---|---|
| `WAIT_FOR_EVENT` | `domcontentloaded` | Puppeteer navigation wait |
| `SETTLE_TIMEOUT_MS` | `12000` | max wait for network-idle after nav (0 disables) |
| `NETWORK_IDLE_MS` | `600` | idle window that counts as "settled" |

This one combo renders SSR/hybrid pages *and* SPAs with no per-site config.
(`renderer/src/util/renderer.ts`, `renderer/src/util/env.ts`.)

#### Per-render tuning knob (CLI + UI)

When a site needs different settings, options can be passed **per render** instead
of changing the global env. A `renderOptions` JSON column on `RenderJob` carries
`{ waitUntil, settleTimeoutMs, networkIdleMs, waitForSelector }` from submission →
job → renderer, which override the env defaults for that render.

The ephemeral endpoint **`GET /render_preview`** renders any URL on demand with
given options and returns the HTML + derived Markdown + stats as JSON — no managed
page, no cache write — so you can dial in a strategy quickly:

```
GET /render_preview?url=<url>&deviceType=desktop
    &waitUntil=domcontentloaded&settleMs=12000&idleMs=600&selector=<css>
```

Two front-ends hit it:

- **CLI:** `scripts/harper-render-probe.js --url <url> --wait <event> --settle <ms>
  --idle <ms> --selector <css> --show md` — prints status, byte/timing stats, and a
  Markdown sample.
- **UI:** the demo's **Render Lab** at `GET /lab` (proxied via `POST /render-lab` so
  the bot-key stays server-side). It shows raw-fetch vs rendered body-text length
  (the CSR-gap signal), token counts (raw HTML vs derived Markdown), and a Markdown
  preview. Configure the target Harper with `HARPER_PREVIEW_URL` / `HARPER_BOT_KEY`.

**On-demand renders need `THREADS=1`** (set in `docker-compose.yml`). With multiple
component threads, the orchestrator must route a render result back to the thread
awaiting it (`handleContent` → `getCallbackThread` → cross-thread stream transfer);
that hop is unreliable here, so a `waitForResponse` render (`/render_preview`, the
on-demand `/page` path) completes the render but never resolves the HTTP request.
The scheduled/managed path is unaffected (it writes the cache directly, no
callback). Single-thread is fine for dev/demo; production multi-thread needs the
upstream cross-thread callback path hardened.

#### Clearing the cache (no DB restart)

`GET|POST /cache_clear?all=true` purges every cached page (+ managed-page schedules
+ the render-job queue); `?url=<url>` clears one URL's device variants. Deletes by
the composite primary key, which is why a plain `DELETE /page_cache/<key>` over REST
doesn't work (the key contains `/` and `|`). The Render Lab has **Clear this URL**
and **Clear ALL cache** buttons (via `POST /cache-clear`); the same is one curl:
`curl -X POST -H "x-pr-req-key:" "$HARPER/cache_clear?all=true"`.

The renderer also has `restart: unless-stopped` in compose: Harper's first-run
install takes ~30s and the renderer connects at startup, so it self-heals the
startup race instead of exiting.

### 3. EdgeWorker — `edgeworker-orchestrator/`

`harper-client.js` exposes `fetchFromHarper` (Markdown, `/page_content`) and
`fetchHtmlFromHarper` (HTML, `/page/`), sharing one request core and failure
taxonomy (timeout / http-error / wrong-content-type / retry-after /
network-error). `main.js` classifies traffic and applies the two fallback paths.

#### Per-crawler content negotiation

`crawler-policy.js` (pure, unit-tested, shared verbatim with the demo UI) decides
**HTML vs Markdown per crawler** — both representations come from the *same*
cached render, so it's pure routing. Identity is an injected **`X-Bot-Kind`**
header in the demo (sibling of `X-Verified-Bot`); in production it comes from
Akamai Bot Manager's *verified* bot signal + User-Agent. The policy is config:

- **`PMUSER_CRAWLER_POLICY`** — e.g. `googlebot=html,gptbot=markdown,…` (overrides built-in defaults).
- Defaults: Googlebot/Bingbot → **HTML** (search indexing / CSR-SEO); GPTBot, ClaudeBot, PerplexityBot, OAI-SearchBot, Google-Extended → **Markdown** (lean LLM ingestion).
- Precedence: per-crawler policy → `Accept: text/markdown` → generic AI UA → HTML (humans/SEO). Backward compatible with the prior AI-vs-human routing.
- Responses echo **`X-Bot-Kind`** alongside `X-Served-By` for per-crawler observability.

Built to drop into the consolidated EdgeWorker unchanged (it's just config + a
shared module). **Caveats:** the demo header is spoofable (prod uses Bot Manager
verification); serving Googlebot prerendered HTML is safe only because it equals
the user's rendered page (matching render) — materially different content would
be cloaking.

### 4. Fermyon fallback — `akamai-ai-markdown/`

Unchanged from the baseline. On-demand HTML→Markdown for the AI path when Harper
has no Markdown for a URL.

---

## Production topology

```
Akamai edge (EdgeWorker)
   │  hits public delivery URL (low latency, in the request path)
   ▼
Harper Cloud ── cache + RenderJob queue + MQTT + /page & /page_content delivery
   ▲  claim jobs (HTTP) · queue status (MQTT/WSS) · upload gzip HTML (HTTP)
   │
Renderer (Puppeteer) on Akamai Cloud Compute / Linode  (off the request path)
   │  fetch + execute JS
   ▼
Origin (Linode Object Storage / customer site)
```

- **Harper Cloud** hosts the component: managed, edge-proximate, and it exposes
  the public delivery URL the EdgeWorker calls on every request.
- **The renderer** runs on **Akamai Cloud Compute (Linode)** — same vendor as the
  origin bucket. It never talks to the edge, so its proximity to the CDN does not
  matter; it only needs a fat pipe to Harper and enough cores for Chrome. Scale
  it horizontally with unique `WORKER_ID`s.

### Deploy — Harper component (Harper Cloud)

1. Deploy `harper-prerender/` to your Harper Cloud instance (Harper Studio →
   deploy from Git, or the operations API). Harper installs the component's
   dependencies (incl. `node-html-markdown`).
2. Set the bot-routing secret on the component: `BOT_REQUEST_KEY_NAME=x-pr-req-key`
   and `BOT_REQUEST_KEY=<secret>`.
3. Pre-populate the cache (`scripts/harper-bulk-upload.js`) so first crawler hits
   are warm.

### Deploy — renderer (Linode)

```bash
cd renderer
docker build -t prerender/renderer .
docker run -d --restart=always --shm-size=1g --name renderer \
  -e HDB_HOST=<instance>.harperdbcloud.com \
  -e HDB_HTTP_PORT=9926 -e HDB_MQTT_PORT=1883 \
  -e HDB_USER=<renderer-user> -e HDB_PASS=<pass> \
  -e WORKER_ID=linode-ord-1 -e NODE_ENV=production \
  prerender/renderer
```

`NODE_ENV=production` selects HTTPS/WSS to Harper Cloud. Use a Harper user scoped
to read/write `local.render_jobs` and `local.queue_status`.

### Configure — Akamai

1. Property variables (Control Center → Property Manager → Property Variables):

   | Variable | Value | Sensitive |
   |---|---|---|
   | `PMUSER_HARPER_ENABLED` | `true` | no |
   | `PMUSER_HARPER_URL` | `https://<instance>.harperdbcloud.com` | no |
   | `PMUSER_HARPER_BOT_KEY` | `<secret>` (matches `BOT_REQUEST_KEY`) | **yes** |
   | `PMUSER_HARPER_TIMEOUT_MS` | `1500` | no |
   | `PMUSER_AI_CRAWLER_UAS` | *(optional UA override)* | no |

2. **Property rule change:** the EdgeWorker must now run for **all page traffic**
   (humans are served prerendered HTML), not only `X-Verified-Bot: true`. Keep
   **Continue-on-Error** enabled so any EdgeWorker failure falls through to origin.
3. Bundle + activate: `cd edgeworker-orchestrator && bash build.sh`, then upload
   in Control Center (Staging → Production).

**Rollback:** set `PMUSER_HARPER_ENABLED=false` (AI → Fermyon, humans → origin
fetch) and/or revert the property rule to the bot-only match.

---

## Local development (docker-compose)

For dev/verification only — not the production path. Requires the Docker daemon
running.

```bash
# 1. Component deps (so the bind-mount is self-contained)
cd harper-prerender && npm install && cd ..

# 2. Bring up origin (CSR sample) + HarperDB (component) + renderer
docker compose up --build

# 3. Queue the CSR sample page for rendering
HARPER_OPS_URL=http://localhost:9926 \
HARPER_ADMIN_USER=HDB_ADMIN HARPER_ADMIN_PASS=password \
  node scripts/harper-bulk-upload.js --urls http://origin:8080/

# 4. Verify both representations come from the SAME render
curl -s "http://localhost:9926/page/?url=http://origin:8080/&deviceType=desktop" \
  -H "x-pr-req-key:" --compressed        # → full rendered HTML (not the empty shell)
curl -s "http://localhost:9926/page_content?path=http://origin:8080/" \
  -H "x-pr-req-key:" --compressed        # → Markdown derived from that HTML
```

> Harper config keys can vary by image tag. If the `MQTT_*` env vars in
> `docker-compose.yml` are not honored, mount a `harperdb-config.yaml` with the
> same keys nested under `mqtt:` / `http:` / `operationsApi:`.

To test the **EdgeWorker** routing without cloud or Docker, point it at the mock:

```bash
node scripts/mock-harper-server.js   # serves /page (HTML) + /page_content (MD), scenario-driven
```

---

## Verification status

- ✅ Markdown derivation (`harper-prerender/src/util/markdown.test.js`) — JSON-LD
  preserved, runtime JS stripped, gzip in/out, graceful nulls.
- ✅ EdgeWorker client (`edgeworker-orchestrator/harper-client.test.js`) — 23
  cases incl. the new HTML path and bot-key header.
- ✅ Renderer TypeScript compiles (`renderer` → `npm run build`).
- ✅ **Full container end-to-end** against HarperDB 4.7.32 + the Puppeteer
  renderer via `docker compose`:
  1. Component loads; `/page`, `/page_content`, `/sitemaps` route; bot-key auth
     gates (401 without the key).
  2. Submit the CSR sample → renderer claims the job, executes its JS, uploads
     the rendered HTML.
  3. `GET /page/?url=…` returns the **rendered** snapshot — the `Loading…` shell
     is replaced, the app `<script>` is stripped, and the product content + JSON-LD
     are present (a plain origin fetch shows only the shell).
  4. `GET /page_content?path=…` returns Markdown derived from that **same** render,
     with JSON-LD preserved as a fenced block.
  5. Graceful fallbacks: 503 on cache miss / unmanaged URL (edge → origin/Fermyon),
     200 on cache hit.

**Validated live against three real flagship phone pages** (datacenter IP, no
proxy):

| Page | Result |
|---|---|
| AT&T iPhone 17 Pro | ✅ 312 KB HTML / 17.7 KB Markdown |
| Apple iPhone 17 Pro | ✅ 124 KB HTML / 29.5 KB Markdown (after the trailing-slash fix) |
| Verizon Business iPhone 17 Pro Max | ✅ 66 KB HTML / 18 KB Markdown — a client-rendered SPA that returned a 973-byte shell under `load`; the network-idle settle step renders it fully |

Bugs / gaps found and fixed during this work: `JobQueue.js` import paths; the
renderer Dockerfile omitting `typescript`; a **submit↔deliver URL normalization
mismatch** (`Sitemap.post` stored URLs verbatim while delivery normalized them);
`normalizeUrl` stripping a trailing slash (caused 301-redirect cache misses, e.g.
Apple); the `/page` handler returning 500 instead of 503 on a miss; the **SPA
wait strategy** (settle step above); and the renderer **startup race** (restart
policy above).
