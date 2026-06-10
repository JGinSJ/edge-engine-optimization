# Demo fixtures

The real customer-page snapshots (Salesforce, telco) that used to live here were
**removed** when the four POCs were consolidated into this public-bound monorepo —
republishing scraped third-party pages and their embedded analytics keys isn't
appropriate for a public repo.

`fixtures.json` (metadata only) is kept.

**TODO:** add neutral, self-authored sample pages here so the offline
token-comparison demo flow works without third-party content. Until then, the
demo falls back to a **live fetch** for any real URL entered in the UI.
