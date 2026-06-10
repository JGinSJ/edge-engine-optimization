# Security & Secrets Policy

This is a proof-of-concept. Treat it as such: **no real credentials, tokens, or
private hostnames belong in source control.** This document records how the
project keeps secrets out of the repo and what to check before publishing.

## How configuration is supplied (never hardcoded)

| Concern | Where it lives | Never in |
|---|---|---|
| Harper delivery URL / token / bot-key | Akamai **property variables** (`PMUSER_HARPER_URL`, `PMUSER_HARPER_TOKEN`, `PMUSER_HARPER_BOT_KEY`) read at request time | EdgeWorker source / git |
| Fermyon Wasm URL | property variable `PMUSER_WASM_URL` (EdgeWorker) / `WASM_URL` env (demo UI) — POC default in source is a public endpoint, override for your own | — |
| Harper admin user / pass (tooling) | environment variables (`HARPER_ADMIN_USER`, `HARPER_ADMIN_PASS`) | git, scripts |
| Component bot-key | component env (`BOT_REQUEST_KEY`) / Harper config | git |
| Renderer ↔ Harper creds | container env (`HDB_USER`, `HDB_PASS`) | image / git |
| Demo target host | `PRODUCTION_HOST` env (demo UI) | — |

`.env`, `.claude/settings.local.json`, and the scraped enterprise fixtures
(`demo-ui/fixtures/*.html`) are **git-ignored** — see `.gitignore`. The
docker-compose admin password (`HDB_ADMIN`/`password`) is a throwaway **local-dev
default only**; never reuse it anywhere real.

## Pre-publish checklist

Before pushing or making the repo public, grep the tree (excluding
`node_modules`, `.git`, `dist`, `target`) for:

- credentials: `password`, `secret`, `token`, `authorization`, `bearer`, JWT-like
  strings, `*_KEY`;
- identities: real emails / usernames;
- private infrastructure: internal hostnames, IPs, bucket names, signed edge
  tokens, third-party analytics keys.

Anything found should be moved to an environment variable / property variable, or
removed. The scraped enterprise fixtures are excluded precisely because they carry
third-party analytics keys, edge-internal debug data, and copyrighted content —
use `demo-pages/csr-flagship.html` (synthetic) for a public, controlled example.

## If a secret is committed

1. **Rotate it immediately** — assume anything pushed is compromised, even if the
   commit is later removed.
2. Remove it from history (`git filter-repo` / BFG) before the repo goes public.
3. Add the path to `.gitignore` so it can't return.

## Reporting

This is a demo project, not a production service. For vulnerabilities in the
underlying platforms, report to the respective vendors (Akamai, Harper, Fermyon).
