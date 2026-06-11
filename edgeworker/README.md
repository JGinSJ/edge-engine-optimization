# Unified read-only EdgeWorker (Phase B)

**One bundle, four scenarios by `PMUSER_*` property config.** This is the Phase B
consolidation target — it replaces the four per-scenario EWs. The EW is **read-only**
against Harper; the Function does the write-through.

## Scenarios → config

| Scenario | `HARPER_ENABLED` | `HARPER_READ_MODE` | `WRITE_THROUGH` | `SERVE_HTML` | notes |
|---|---|---|---|---|---|
| cdn-cache | `false` | — | `false` | `false` | Fermyon convert → MD, Akamai CDN caches |
| md-cache | `true` | `markdown_cache` | `true` | `false` | Fermyon writes Harper on miss (gq4 node) |
| convert-cache | `true` | `page_content` | `false` | `false` | Harper self-populates; Fermyon = fallback |
| prerender | `true` | `page_content` | `false` | `true` | HTML+MD per-crawler — **next increment** |

Other vars: `PMUSER_HARPER_URL` (read base, e.g. `/_harper`), `PMUSER_HARPER_WRITE_URL`
(absolute gq4 node — must match the read node; the Fabric cluster doesn't replicate),
`PMUSER_HARPER_TOKEN`, `PMUSER_WASM_URL` (Akamai-fronted `.fwf.app`),
`PMUSER_CRAWLER_POLICY` / `PMUSER_SERVE_HTML` (prerender, next increment).

## Status

- ✅ **MD scenarios** (cdn-cache, md-cache, convert-cache) wired; **md-cache** validated
  against its proven backend.
- ⏳ **Next increment:** the prerender path — HTML read (`/page?url=`), `SERVE_HTML`
  human→prerendered-HTML, and per-crawler routing (`crawler-policy.js` + `CRAWLER_POLICY`).

## Build / test

```
node --test harper-read.test.js   # unit tests (both read modes)
./build.sh                        # → bundle.tgz → upload to the unified EW ID
```

Full design: `~/Documents/Jorge's Vault/Notes/2026-06-10-phase-b-unified-read-only-edgeworker-spec.md`.
