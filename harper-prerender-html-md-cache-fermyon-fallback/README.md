# Harper Prerender — HTML + Markdown Cache with Fermyon Fallback

[![CI](https://github.com/JGinSJ/harper-prerender-html-md-cache-fermyon-fallback/actions/workflows/ci.yml/badge.svg)](https://github.com/JGinSJ/harper-prerender-html-md-cache-fermyon-fallback/actions/workflows/ci.yml)

An Edge-native pipeline that intercepts traffic at the Akamai edge and serves
**prerendered HTML to humans and SEO crawlers** and **clean Markdown to AI
crawlers** — including for **client-side-rendered (CSR) pages**, without touching
origin code.

Built on Akamai EdgeWorkers, a Harper component with a headless-Chrome renderer
(Puppeteer), and a Fermyon Spin WebAssembly fallback.

> This extends the baseline [`serverless-ai-seo-pipeline`](https://github.com/)
> (which serves Markdown to AI crawlers from a plain-fetch Harper cache). The new
> capability is **JavaScript rendering**: Harper executes the page in a headless
> browser, caches the full HTML, and derives Markdown from that *rendered* HTML.

---

## The problem it adds

The baseline does a plain HTTP fetch before converting HTML→Markdown. For a
**client-side-rendered** page that returns an empty JS shell, the fetch sees no
content — so both the Harper markdown path and the Fermyon fallback cache/convert
nothing useful. Server-rendered pages work; CSR pages don't.

## The solution

A headless-Chrome renderer executes the page's JavaScript and produces the real,
fully-rendered HTML. That HTML is cached in Harper **once** and:

- served as **HTML** to humans / SEO crawlers (origin fetch as fallback), and
- converted to **Markdown** (stored on the same cache record) and served to AI
  crawlers (Fermyon Wasm as fallback).

One render → one cache record → two representations.

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

`X-Served-By` on every response is one of `harper-cache-html`, `harper-cache-md`,
`fermyon-fallback`, or `origin-fallback`.

Full design, cache schema, renderer contract, and production deploy:
[`docs/integrations/harper-prerender-architecture.md`](docs/integrations/harper-prerender-architecture.md).

---

## Repository structure

```
.
├── edgeworker-orchestrator/   # Akamai EdgeWorker — traffic classifier + Harper/Fermyon/origin orchestrator
│   ├── main.js                #   dual HTML/Markdown routing + fallbacks
│   ├── harper-client.js       #   fetchFromHarper (MD) + fetchHtmlFromHarper (HTML)
│   ├── harper-client.test.js  #   23 unit tests (node:test, zero-install)
│   └── build.sh, bundle.json
├── harper-prerender/          # Unified Harper component (fork of template-static-prerender)
│   ├── data/schema.graphql    #   PageCache holds HTML + derived Markdown blobs
│   ├── src/util/markdown.js   #   HTML→Markdown derivation (+ JSON-LD preservation)
│   ├── src/util/markdown.test.js
│   ├── src/resources/         #   /page (HTML) + /page_content (MD) delivery, job queue, sitemap
│   └── localExtensions/orchestrator/  # render-result write path (derives Markdown here)
├── renderer/                  # Headless-Chrome Puppeteer renderer (fork of template-static-prerender)
├── akamai-ai-markdown/        # Fermyon Spin Wasm — on-demand HTML→Markdown fallback (unchanged)
├── docker-compose.yml         # Local dev: origin (CSR sample) + HarperDB + renderer
├── scripts/
│   ├── harper-bulk-upload.js  # Queue URLs/sitemaps for rendering (POST /sitemaps)
│   ├── mock-harper-server.js  # Local mock: /page (HTML) + /page_content (MD) scenarios
│   └── csr-sample/            # JS-only page that demonstrates the CSR gap
├── demo-ui/                   # Token-comparison demo UI (from baseline)
└── docs/integrations/
    ├── harper-prerender-architecture.md   # ← architecture + deploy (start here)
    └── harper-integration-spec.md         # baseline contract + supersession notes
```

---

## Run it locally

**Prerequisites:** [Docker Desktop](https://www.docker.com/products/docker-desktop/)
(running) and Node 18+. On a fresh Mac:

```bash
brew install --cask docker      # then launch Docker Desktop and wait for "running"
brew install node git
```

**One command** — installs deps, builds + starts the stack (origin + HarperDB +
Puppeteer renderer), then runs the demo UI on http://localhost:8090:

```bash
git clone https://github.com/JGinSJ/harper-prerender-html-md-cache-fermyon-fallback.git
cd harper-prerender-html-md-cache-fermyon-fallback
./dev.sh          # Ctrl+C stops the UI; the stack keeps running
./dev.sh down     # stop the Docker stack
```

> First run pulls the HarperDB image and builds the renderer (downloads Chrome —
> a few minutes, once). A fresh clone does **not** include the scraped enterprise
> fixtures (gitignored); use the **Render Lab** (any public URL), the **Aether One
> Pro** example, or the CLI probe below for self-contained demos. Local data is
> ephemeral — `./dev.sh down` clears cached renders.

## Quick start (manual)

Requires the Docker daemon running. (`./dev.sh` automates all of this.)

```bash
# Component deps (so the docker bind-mount is self-contained)
cd harper-prerender && npm install && cd ..

# origin (CSR sample) + HarperDB (component) + renderer
docker compose up --build

# Queue the CSR sample for rendering
HARPER_OPS_URL=http://localhost:9926 HARPER_ADMIN_USER=HDB_ADMIN HARPER_ADMIN_PASS=password \
  node scripts/harper-bulk-upload.js --urls http://origin:8080/

# Both representations, from the SAME render:
curl -s "http://localhost:9926/page/?url=http://origin:8080/&deviceType=desktop" -H "x-pr-req-key:" --compressed
curl -s "http://localhost:9926/page_content?path=http://origin:8080/"            -H "x-pr-req-key:" --compressed
```

### Tune a render (the "knob")

Dial in the wait strategy per URL without rebuilding — same options from the CLI
and the UI, both calling Harper's ephemeral `/render_preview` (no cache write):

```bash
# CLI probe
HARPER_URL=http://localhost:9926 node scripts/harper-render-probe.js \
  --url https://example.com/spa-page \
  --wait domcontentloaded --settle 12000 --idle 600 --selector "h1" --show md

# UI: start the demo, open the Render Lab
cd demo-ui && npm install && PORT=8090 node server.js   # → http://localhost:8090/lab
```

The Render Lab shows raw-fetch vs rendered body-text (the CSR-gap signal), token
counts (raw HTML vs derived Markdown), and a Markdown preview.

### A controlled client-rendered example page

`demo-pages/csr-flagship.html` is a self-contained, JS-rendered product page (a
fictional "Aether One Pro") for demoing the CSR gap on a domain you control — a
raw fetch sees only a `Loading…` shell; a headless render produces the full
catalog (specs, reviews, FAQ, JSON-LD). Host it on your own Object Storage origin
and it shows up in the demo's example list:

```bash
# 1. Upload to your Object Storage origin (Akamai/Linode S3-compatible)
s3cmd put --acl-public demo-pages/csr-flagship.html \
  s3://YOUR-BUCKET/csr-flagship.html \
  --host=us-ord-1.linodeobjects.com "--host-bucket=%(bucket)s.us-ord-1.linodeobjects.com"

# 2. The example is wired to https://momentumoverperfection.com/csr-flagship.html
#    in demo-ui/fixtures.json — update that URL if the domain/path changes.
```

Selecting it in the demo pre-fills both the main URL and the Render Lab, so you
can run the 3-scenario flow and render it through the local prerender pipeline.

See the architecture doc for the production deploy (Harper Cloud + renderer on
Akamai Cloud Compute/Linode) and the Akamai property configuration.

---

## Tests

```bash
npm test                       # EdgeWorker client — 23 cases, zero-install
cd harper-prerender && npm test   # Markdown derivation — 6 cases
cd renderer && npm run build      # Renderer TypeScript compiles
```

---

## Honest limitations

This is a POC. Be transparent when demoing:

1. **CSR is solved by the renderer, not the Wasm fallback.** Fermyon (and a plain
   origin fetch) still only see the un-rendered shell. The Fermyon path is a
   best-effort fallback for the AI path; the *rendered* content comes from Harper.
2. **No real bot verification.** Routing keys off `Accept: text/markdown` / the
   User-Agent list. Both are spoofable; in production this is paired with Akamai
   Bot Manager's verified `X-Verified-Bot` signal.
3. **Humans now route through the edge.** Serving prerendered HTML to humans
   requires the property rule to invoke the EdgeWorker for all traffic (with
   Continue-on-Error). Roll back via `PMUSER_HARPER_ENABLED=false` and/or the
   bot-only rule.
4. **Ephemeral local data.** The dev `docker-compose.yml` runs HarperDB without a
   persistence volume (to avoid LMDB lock-permission issues with a root-owned
   named volume). Cached renders are lost on `docker compose down`; re-submit
   after a restart. Production (Harper Cloud) persists normally.

## Security & configuration

No real credentials or private hostnames live in source — Harper/Fermyon config is
supplied via Akamai property variables and environment variables (see
[`.env.example`](.env.example)). The scraped enterprise demo fixtures
(`demo-ui/fixtures/*.html`) are **git-ignored** (they carry third-party analytics
keys, edge-internal debug data, and copyrighted content) — they stay on your
machine for local demos; the public, controlled example is
[`demo-pages/csr-flagship.html`](demo-pages/csr-flagship.html). See
[SECURITY.md](SECURITY.md) for the full policy and pre-publish checklist.

## License

[MIT](LICENSE)
