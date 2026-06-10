# edge-engine-optimization

**Edge-native Engine Optimization** — serving search, generative, and answer engines (**SEO · GEO · AEO**) the optimal representation of your content at the Akamai edge, with no origin changes.

> "Engine Optimization" is the superset: SEO → **S**earch engines (Google, Bing) · GEO → **G**enerative engines (ChatGPT, Gemini, Copilot) · AEO → **A**nswer engines (Perplexity, AI Overviews, assistants). Same idea, different engine in front — the platform serves each the right representation (HTML / Markdown) at the edge.

## What's here

This monorepo consolidates four AI-SEO proof-of-concepts. They are one idea at four points on a spectrum, distinguished by **who converts** (Fermyon vs Harper) and **what's cached**:

| Directory (taxonomy name) | Imported from | What it does |
|---|---|---|
| `fermyon-convert-cdn-cache/` | edge-ai-markdown | Fermyon converts HTML→Markdown at the edge; CDN-cached; no Harper |
| `fermyon-convert-harper-md-cache/` | harper-cache-pipeline | Fermyon converts; Harper is a passive write-through Markdown cache (EW reads, Fermyon writes back) |
| `harper-convert-cache-fermyon-fallback/` | serverless-ai-seo-pipeline | Harper actively prerenders Markdown; Fermyon as fallback |
| `harper-prerender-html-md-cache-fermyon-fallback/` | harper-prerender-…-fermyon-fallback | Harper prerenders unified HTML+MD from one render; per-crawler content negotiation; Fermyon fallback |

These collapse to **3 SE demo scenarios** (the two middle rows are the same "write-through cache" story). The unified tabbed demo is built on the `harper-prerender` advanced UI (tab framework + Render Lab + per-crawler `crawler-policy.js`).

## Status

- **Imported as-is, history preserved** (`git subtree`). Each subdir still builds/runs on its own for now.
- **Next (planned):** Phase A — merge the demo layer into one tabbed demo (`demo/`); Phase B — collapse backends onto a single read-only EdgeWorker. See the consolidation spec (private vault).

## Platform constraints (carry across all scenarios)

- The Akamai EdgeWorker `httpRequest()` reaches **only Akamai-fronted hosts** — converters must be on **Fermyon Wasm Functions on Akamai** (`spin aka deploy` → `*.fwf.app`), **not** Fermyon Cloud (`*.fermyon.app` / AWS).
- Harper **writes** go via Fermyon (EW write to Harper is blocked at the edge); Harper **reads** go via the on-property `/_harper` proxy.
- `PMUSER_*` config lives in Akamai property variables, never in this repo.
