# edge-engine-optimization

**Edge-native Engine Optimization** — serving search, generative, and answer engines (**SEO · GEO · AEO**) the optimal representation of your content at the Akamai edge, with no origin changes.

> "Engine Optimization" is the superset: SEO → **S**earch engines (Google, Bing) · GEO → **G**enerative engines (ChatGPT, Gemini, Copilot) · AEO → **A**nswer engines (Perplexity, AI Overviews, assistants). Same idea, different engine in front — the platform serves each the right representation (HTML / Markdown) at the edge.

## How it works

A verified crawler hits the edge. One **read-only EdgeWorker** classifies it and serves the right representation:

- **AI crawlers** get clean **Markdown** — either straight from a **Harper** cache, or converted on demand by an **Akamai Function** (Wasm) that the EdgeWorker calls, with the result optionally cached back into Harper or the CDN.
- **Search crawlers** (and humans, where enabled) get **prerendered HTML** from Harper, falling back to origin.

The EdgeWorker never writes Harper itself (blocked at the edge) — the Akamai Function performs the write-through. Reads go via the on-property `/_harper` proxy.

## What's here

| Path | What it is |
|---|---|
| **`demo/`** | The unified tabbed sales-engineering demo (3 scenarios) — token savings, cache behavior, Render Lab, per-crawler negotiation. |
| **`edgeworker/`** | The single unified **read-only EdgeWorker** — one bundle, four scenarios by `PMUSER_*` property config. |
| **`fermyon-convert-harper-md-cache/akamai-ai-markdown/`** | The **Akamai Function** converter (Rust/Wasm) — HTML→Markdown, with optional Harper write-through. Deployed via `spin aka`. |
| **`harper-prerender-html-md-cache-fermyon-fallback/`** | The **prerender backend** — headless `renderer/` + the `harper-prerender/` Harper component that produces the unified HTML+Markdown render. |

### The four scenarios (one EdgeWorker, config only)

| Scenario | `HARPER_ENABLED` | `HARPER_READ_MODE` | `WRITE_THROUGH` | `SERVE_HTML` |
|---|---|---|---|---|
| cdn-cache | `false` | — | `false` | `false` |
| md-cache | `true` | `markdown_cache` | `true` | `false` |
| convert-cache | `true` | `page_content` | `false` | `false` |
| prerender | `true` | `page_content` | `false` | `true` + `CRAWLER_POLICY` |

The demo surfaces three of these as tabs (cdn-cache, md-cache, prerender). See `edgeworker/README.md` for the full config matrix.

## Quick start (demo)

```bash
cd demo && npm install && npm start        # http://localhost:8080
# staging (until production DNS is cut to Akamai):
AKAMAI_STAGING=1 npm start
```

## Platform constraints (carry across all scenarios)

- The Akamai EdgeWorker `httpRequest()` reaches **only Akamai-fronted hosts** — the converter must be on **Akamai Functions** (`spin aka deploy` → `*.fwf.app`), **not** Fermyon Cloud (`*.fermyon.app` / AWS).
- Harper **writes** go via the Akamai Function (an EdgeWorker write to Harper is blocked at the edge); Harper **reads** go via the on-property `/_harper` proxy. Writes and reads must target the **same Harper node** (the Fabric cluster endpoint does not replicate to it).
- `PMUSER_*` config lives in Akamai property variables, never in this repo.
