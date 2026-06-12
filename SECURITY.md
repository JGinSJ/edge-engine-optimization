# Security Policy

## Reporting a vulnerability

Please report security issues privately via [GitHub Security Advisories](https://github.com/JGinSJ/edge-engine-optimization/security/advisories/new) rather than opening a public issue. We aim to acknowledge reports within a few business days.

## Secrets & configuration

This repository contains **no secrets**. All runtime configuration lives in Akamai
property variables (`PMUSER_*`) and environment files that are git-ignored:

- Harper tokens, node URLs, and bot keys are **never** committed — they are set as
  `PMUSER_*` property variables on the Akamai property.
- `.env` files are git-ignored; only `.env.example` templates (no live values) are committed.

## Demo content

The demo's offline fixtures are **self-authored synthetic pages** — no third-party
or scraped content. Live demo runs fetch only fetch-friendly public URLs you supply.

## Scope

This is a proof-of-concept / demonstration project. The EdgeWorker is read-only at
the edge (it never writes to Harper directly); writes are performed by the Akamai
Function. Demo mode (`PMUSER_DEMO_MODE`) lets a request select a scenario and must
**only** be enabled on demo properties, never on a production customer property.
