# Contributing

Thanks for your interest. This repo is a proof-of-concept; contributions and issues are welcome.

## Layout

| Path | What it is |
|---|---|
| `demo/` | Unified tabbed sales-engineering demo (Node) |
| `edgeworker/` | The unified read-only Akamai EdgeWorker (one bundle, four scenarios by config) |
| `fermyon-convert-harper-md-cache/akamai-ai-markdown/` | The Akamai Function converter (Rust/Wasm) |
| `harper-prerender-html-md-cache-fermyon-fallback/` | The prerender backend (headless renderer + Harper component) |

## Working on the EdgeWorker

```bash
cd edgeworker
node --test *.test.js     # unit tests (currently 47)
./build.sh                # → bundle.tgz to upload to the EdgeWorker
```
The EdgeWorker stays **read-only** against Harper — writes are performed by the
Akamai Function. Configuration is via `PMUSER_*` property variables; never commit
secrets (see [SECURITY.md](SECURITY.md)).

## Working on the demo

```bash
cd demo && npm install && npm start     # http://localhost:8080
```

## Conventions

- Keep the unit tests green (`node --test` in `edgeworker/`).
- Match the surrounding code style; keep comments focused on the *why*.
