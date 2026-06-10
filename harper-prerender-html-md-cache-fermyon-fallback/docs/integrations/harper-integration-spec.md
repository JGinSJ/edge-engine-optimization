# Harper Prerender — Integration Spec

> **This project supersedes the baseline contract below with a unified
> component.** See [`harper-prerender-architecture.md`](./harper-prerender-architecture.md)
> for the current design. Key differences from this baseline spec:
>
> - **Source of truth is now** [`template-static-prerender`](https://github.com/HarperFast/template-static-prerender)
>   (headless-Chrome rendering), forked into `harper-prerender/` and extended to
>   also derive + cache Markdown from the rendered HTML.
> - **Two delivery endpoints**: `GET /page/?url=<url>&deviceType=…` → `text/html`
>   (humans/SEO) and `GET /page_content?path=<url>` → `text/markdown` (AI). Both
>   are produced from a **single render** and stored on one cache record.
> - **Auth** is the `x-pr-req-key` header (component `BOT_REQUEST_KEY`), sent by
>   the EdgeWorker from `PMUSER_HARPER_BOT_KEY`. The legacy `Authorization:
>   Bearer` header is still sent for compatibility but is not what the component
>   checks.
> - **Submission** is `POST /sitemaps` (`{sitemapURL, refreshInterval, isSitemap,
>   urlList, deviceTypes}`), not `/bulk_upload`.
>
> The sections below are retained as the historical baseline (markdown-only)
> reference.

Source of truth (baseline): https://github.com/HarperFast/template-markdown-prerender

---

## Overview

Harper Markdown Prerender is a HarperDB component that fetches origin HTML,
converts it to Markdown, and caches the result. This EdgeWorker calls Harper
first for verified bot traffic; on any failure it falls back to Fermyon.

---

## Authentication

```
Authorization: Bearer <HARPER_TOKEN>
```

HARPER_TOKEN is the token value provided by Harper, used verbatim after "Bearer ".

> **Note:** The original spec documented `Basic` auth. Live testing against the Harper
> delivery endpoint confirmed it requires `Bearer`. `Basic` returns `401 {"error":"Invalid character"}`.

---

## Endpoint: GET /page_content

### Request

```
GET /page_content?path=<full-target-url>
Headers:
  Authorization: Bearer <HARPER_TOKEN>
  X-Query-String: ?<query-string>   # only when origin URL has a query string
                                    # Harper auto-prepends ? if missing
```

Three equivalent ways to supply the target URL (priority order):
1. Encoded URL path segment: `GET /page_content/https%3A%2F%2Fexample.com`
2. Query parameter: `GET /page_content?path=https://example.com/page`
3. Path header: `GET /page_content` with `Path: https://example.com/page`

This integration uses method 2 (query parameter).

### Successful response

```
Status:  200
Content-Type:     text/markdown; charset=utf-8
Content-Encoding: gzip
Cache-Control:    public, max-age=<refreshInterval-in-seconds>
Last-Modified:    <RFC1123>
Server-Timing:    fetch-resolve;dur=X, process-resolve;dur=Y   # on cache miss only
```

### Error response

```
Status:  503
Content-Type:     text/markdown; charset=utf-8
Retry-After:      300
```

Harper returns a static Markdown error page on origin fetch failure or timeout.
Content-Encoding is removed on error responses.

### Fallback trigger conditions

| Condition | Reason code passed to Fermyon |
|---|---|
| Status 5xx | `http-error` |
| `Retry-After` header present | `retry-after` |
| `Content-Type` is not `text/markdown` on 2xx | `wrong-content-type` |
| Request time > HARPER_TIMEOUT_MS | `timeout` |
| Network error / connection refused | `network-error` |

Note: `wrong-content-type` on 2xx is not currently produced by Harper's code
(error responses use text/markdown with 503), but the guard is kept defensively.

Note: `retry-after` on a 200 is not produced by Harper's current code (retry-after
only appears on 503 error responses). The guard is kept for forward compatibility.

---

## Endpoint: POST /bulk_upload

### Request — URL list mode

```json
{
  "urlList": ["https://example.com/a", "https://example.com/b"],
  "refreshInterval": 864000000
}
```

### Request — single URL mode

```json
{
  "url": "https://example.com/page",
  "refreshInterval": 864000000
}
```

### Request — sitemap mode

```json
{
  "sitemap": "https://example.com/sitemap.xml",
  "isIndex": false,
  "pageRefreshInterval": 864000000,
  "sitemapRefreshInterval": 1728000000
}
```

`sitemapRefreshInterval` defaults to `2 × pageRefreshInterval` when omitted.

### Response codes

| Status | Meaning |
|---|---|
| 201 | All URLs queued successfully |
| 207 | Partial success — some URLs failed, others queued |
| 400 | Invalid or missing parameters |
| 500 | Server error |

---

## Configuration — Akamai property variables

Secrets are managed as Akamai property variables in Control Center, not in
source code. The EdgeWorker reads them at request time via
`request.getVariable()`. Define these under Property Variables on the property:

| Property variable | Purpose | Sensitive | Default |
|---|---|---|---|
| `PMUSER_HARPER_ENABLED` | Feature flag — set to `'true'` to enable | no | `'false'` |
| `PMUSER_HARPER_URL` | Harper delivery host base URL | no | (required when enabled) |
| `PMUSER_HARPER_TOKEN` | Bearer token provided by Harper | **yes** | (required when enabled) |
| `PMUSER_HARPER_TIMEOUT_MS` | Milliseconds before falling back to Fermyon | no | `'1500'` |

Mark `PMUSER_HARPER_TOKEN` as **Sensitive** in Control Center so it is masked
in logs and excluded from the metadata API response.

See `.env.example` for a local reference of all variable names and descriptions.

---

## Observability headers (on bot responses)

| Header | Condition | Value |
|---|---|---|
| `X-Served-By` | Harper succeeds | `harper-cache` |
| `X-Served-By` | Fermyon fallback after Harper attempt | `fermyon-fallback` |
| `X-Harper-Fallback-Reason` | Fermyon fallback | reason code (see table above) |
| *(none)* | `HARPER_ENABLED=false` | — |

---

## Discrepancies found between Appendix A and upstream repo

| Topic | Appendix A | Upstream repo | Resolution |
|---|---|---|---|
| Default refreshInterval | 86400000 (1 day) | 864000000 (10 days) | Use 864000000 |
| Sitemap bulk upload fields | `refreshInterval` | `pageRefreshInterval` + `sitemapRefreshInterval` | Expose both |
| retry-after on 200 | Listed as possible | Not produced by current code | Keep guard defensively |
| wrong-content-type on error | Listed as possible | Errors return text/markdown 503 | Keep guard defensively |
| Auth mechanism | `Authorization: Basic <token>` | `Authorization: Bearer <token>` | Use Bearer — Basic returns 401 in live testing |

---

## Harper internal behavior notes

- **Ad-hoc fetch timeout** (user-triggered /page_content): 3 seconds
- **Scheduled refresh timeout**: 10 seconds
- **Eviction period**: 30 days (records older than this are purged)
- **Stale content**: served by default (`allowStaleContent` defaults to true)
- **PageFilter**: per-path CSS selector rules, stored in DB — not a per-request concern
- **Rate limiting**: none documented in upstream
- **No max retry limit** on failed scheduler jobs
