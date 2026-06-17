# Unified SE demo

One tabbed demo for all the Engine-Optimization scenarios. A **scenario selector**
(top bar) switches which backend the same flow targets; `scenarios.config.json`
holds each scenario's host, converter, and feature flags.

## Run

```bash
npm install
npm start                 # http://localhost:8080
```

### Staging (until production DNS is cut over to Akamai)

The demo hits each scenario's property host, but those hostnames don't yet resolve
to Akamai — so for a staging demo, let each scenario auto-resolve **its own** Akamai
staging edge:

```bash
AKAMAI_STAGING=1 npm start
```

This resolves `<host>.edgekey-staging.net` fresh per request (no global edge pin, no
SNI/cert clashes). Per-scenario overrides live in `scenarios.config.json`
(`stagingHost`, or an explicit `edgeIp`).

## Scenarios

| Tab | What it shows |
|---|---|
| **Edge Convert** | AI bot → Markdown converted at the edge; CDN-cached; no Harper |
| **Write-through Markdown Cache** | 1st AI bot converts + writes to Harper; returning bots served from Harper |
| **Prerender + Per-Crawler** | One render → HTML for search engines, Markdown for AI; per-crawler content negotiation |

> **Scenario C cache state.** The two crawler visits in the demo are only ~2s apart,
> which races the cache write/render — too tight to re-read reliably. How each
> backend handles Scenario C:
> - **Write-through:** the first visit's write is *confirmed* (`X-Cache-Write: ok`),
>   so Scenario C is rendered from that exact entry — shown as a Harper hit with the
>   cache key — rather than re-racing a live read. (A real crawler returns long after
>   the write and always hits.)
> - **Prerender:** the first visit only *triggers* an async render and writes nothing
>   synchronously, so Scenario C can't be shown reliably; the card talk-tracks the
>   timing inline.
> - **Edge Convert (CDN):** keeps its real cache rows — the edge cache fills on the
>   first visit and the return visit hits immediately.

## Seed the prerender cache (optional)

The **Prerender + Per-Crawler** backend only serves URLs registered as **managed
pages** — they're prerendered ahead of time, not on demand. Unlike write-through
(which caches any URL on the first bot visit), prerender returns `503 retry-after`
for an unregistered URL and the edge falls back to origin.

You don't need this for the headline 3-scenario flow (which doesn't display Scenario
C's cache state — see above). But to make the **Per-Crawler View** tab read real
cached content back from Harper — mirroring how production return visits are served —
register the URL first:

```bash
cd ../harper-prerender-html-md-cache-fermyon-fallback

HARPER_OPS_URL=https://<your-harper-host>:9926 \
HARPER_ADMIN_USER=<admin-user> \
HARPER_ADMIN_PASS=<admin-pass> \
  node scripts/harper-bulk-upload.js --urls https://www.djangoproject.com/ --device-types desktop
```

This POSTs to Harper's `/sitemaps` resource, which registers the URL in `ManagedPage`
(`status: scheduled`); the render queue then prerenders it with headless Chrome and
stores both the HTML and derived Markdown in `PageCache`. Give it ~1 minute; the
Per-Crawler View then serves it from Harper (`harper-cache-html` / `harper-cache-md`).

- **`--device-types desktop` matters.** The cache key includes device type, and the
  EdgeWorker's HTML read defaults to `desktop`. The demo sends no `Accept-Language`,
  so the read key reduces to `url + desktop` — seed at least `desktop` or the read
  won't match.
- The Per-Crawler View renders with component defaults and does **not** write the
  cache itself — only the bulk-upload / sitemap path above populates it.

## Tips

- Use a **converter-friendly URL** (some sites return 403/redirects to the converter's
  fetch → the run shows an error). Real content pages from cooperating origins work best.
- The fixture buttons drive the **offline** token-savings comparison from a self-authored
  sample page; the **live** URLs run the full edge pipeline.
- Result cards adapt their labels to the active scenario (Harper cache vs CDN cache).
