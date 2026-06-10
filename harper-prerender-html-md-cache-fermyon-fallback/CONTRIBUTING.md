# Contributing

This is a proof-of-concept reference implementation. Contributions that improve clarity, fix bugs, or extend the architecture are welcome.

## Getting started

1. Fork the repository and clone your fork.
2. Install dependencies: `cd demo-ui && npm install`
3. Run the unit tests: `npm test` (from the repo root)

## What's in scope

- Bug fixes in the EdgeWorker (`edgeworker-orchestrator/`)
- Improvements to the Wasm component (`akamai-ai-markdown/`)
- Demo UI enhancements (`demo-ui/`)
- Documentation improvements

## Making changes

- Keep PRs focused — one logical change per PR.
- Run `npm test` before submitting; all 13 unit tests must pass.
- If you change `main.js` or `harper-client.js`, rebuild the EdgeWorker bundle before testing:
  ```bash
  cd edgeworker-orchestrator
  bash build.sh
  ```
- If you change `src/lib.rs`, rebuild the Wasm component:
  ```bash
  cd akamai-ai-markdown
  spin build
  ```

## Secrets and credentials

Never commit real tokens, passwords, or API keys. Harper configuration is read from Akamai property variables at runtime (`PMUSER_HARPER_URL`, `PMUSER_HARPER_TOKEN`, etc.) — set these in Control Center, not in source code. See `.env.example` for the full variable list and local development equivalents.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
