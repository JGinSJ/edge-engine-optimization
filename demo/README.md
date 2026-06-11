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
| **Prerender + Per-Crawler** | One render → HTML for search engines, Markdown for AI; Render Lab + per-crawler routing |

## Tips

- Use a **converter-friendly URL** (some sites return 403/redirects to the converter's
  fetch → the run shows an error). Real content pages from cooperating origins work best.
- The fixture buttons drive the **offline** token-savings comparison from a self-authored
  sample page; the **live** URLs run the full edge pipeline.
- Result cards adapt their labels to the active scenario (Harper cache vs CDN cache).
