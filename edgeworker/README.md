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
| prerender | `true` | `page_content` | `false` | `true` | HTML+MD per-crawler (`PMUSER_CRAWLER_POLICY`) |

Other vars: `PMUSER_HARPER_URL` (read base, e.g. `/_harper`), `PMUSER_HARPER_WRITE_URL`
(absolute gq4 node — must match the read node; the Fabric cluster doesn't replicate),
`PMUSER_WASM_URL` (Akamai-fronted `.fwf.app`),
`PMUSER_CRAWLER_POLICY` / `PMUSER_SERVE_HTML` (prerender, next increment).

**Harper auth (all reads + write-through):** the Harper Fabric data API authenticates
with **HTTP Basic** — a Bearer token is rejected with `401 "Must login"`. Set
`PMUSER_HARPER_USER` and `PMUSER_HARPER_PASS`; the EdgeWorker sends `Authorization:
Basic` on **every** Harper read (`markdown_cache` and `page_content`/`page`) and forwards
the same credential to the converter (`X-Harper-Authorization`) for the write.
`PMUSER_HARPER_TOKEN` is the legacy Bearer fallback (used only when no user is set) —
and won't authenticate against Harper Fabric. The prerender bot-key (`PMUSER_HARPER_BOT_KEY`
/ `x-pr-req-key`) is still sent alongside Basic for the prerender component's own gate.

## Representation routing

`crawler-policy.js` resolves HTML vs Markdown per crawler. A **verified bot**
(`X-Verified-Bot: true`, Akamai Bot Manager) is treated as wanting Markdown unless
`PMUSER_CRAWLER_POLICY` maps its `botKind` otherwise (e.g. `googlebot=html`). Markdown →
`serveMarkdown` (read-by-mode → Fermyon, gated write-through). HTML → `serveHtml` (Harper
`/page` → origin fallback) when `SERVE_HTML=true`, else humans pass through to origin.

## Status

- ✅ **All four scenarios wired** by config (v2.1.0). md-cache **staging-validated**;
  cdn-cache + convert-cache (MD) and prerender (HTML+per-crawler) wired + unit-tested.
- ⏳ **Staging validation pending** for the prerender path (needs the `nobodycares`
  prerender backend: Harper `/page` + `/page_content`, `PMUSER_SERVE_HTML=true`,
  `PMUSER_CRAWLER_POLICY`, `PMUSER_HARPER_BOT_KEY`).

## Build / test

```
node --test harper-read.test.js   # unit tests (both read modes)
./build.sh                        # → bundle.tgz → upload to the unified EW ID
```

Full design: `~/Documents/Jorge's Vault/Notes/2026-06-10-phase-b-unified-read-only-edgeworker-spec.md`.
