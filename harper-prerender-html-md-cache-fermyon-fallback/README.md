# Prerender Backend (renderer + Harper component)

Part of the [**edge-engine-optimization**](../README.md) monorepo. This subdirectory
is the **prerender backend** — it produces the cached, fully-rendered **HTML + Markdown**
that the unified EdgeWorker (`../edgeworker/`) serves to crawlers. The EdgeWorker and the
demo live at the repo root; only the backend lives here.

## What it does

A plain HTTP fetch of a **client-side-rendered (CSR)** page returns an empty JS shell —
so converting that to Markdown yields nothing useful. This backend solves that:

1. A **headless-Chrome renderer** (`renderer/`, Puppeteer) executes the page's
   JavaScript and produces the real, fully-rendered HTML.
2. A **Harper component** (`harper-prerender/`) caches that HTML **once** and exposes:
   - `GET /page?url=&deviceType=` → prerendered **HTML** (for search engines / humans)
   - `GET /page_content?path=` → **Markdown** derived from the rendered HTML (for AI crawlers)

Both representations come from the same single render. The EdgeWorker reads these via
the on-property `/_harper` proxy; on a miss it falls back to the Akamai Function converter.

## Components

| Path | What it is |
|---|---|
| `renderer/` | Headless-Chrome rendering service (Docker) |
| `harper-prerender/` | Harper component: render cache + `/page` / `/page_content` endpoints |
| `docs/` | Architecture & integration notes |

## Run locally

```bash
docker-compose up        # renderer + Harper component
# or
./dev.sh
```

See `renderer/README.md` and `harper-prerender/README.md` for component details, and
`.env.example` for configuration. No secrets are committed (see [SECURITY.md](../SECURITY.md)).
