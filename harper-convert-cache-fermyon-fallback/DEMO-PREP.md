# DEMO-PREP — Serverless AI-SEO Pipeline

Run this checklist **10 minutes before** every demo.

---

## 1. Smoke test

```bash
bash demo-prep.sh
```

All checks must be green before you open the call. The script exits non-zero on any failure and prints a one-line fix for each. Do not skip a red check and hope it resolves itself mid-demo.

---

## 2. Fixture selection

Decide which pages to show before the demo. The demo lands better when the fixtures match the audience's industry.

| Audience | Lead with | Skip |
|---|---|---|
| CRM / SaaS customer | Cloud CRM Agentforce → Sales Cloud Pricing | Tier 1 Telco pages |
| Telco / device retail | Tier 1 Telco iPhone → Wireless Plans | Cloud CRM pages |
| No specific vertical | WorkHarder Homepage (token story) → one Cloud CRM page | — |
| Mixed / first-time intro | WorkHarder (Problem in Numbers) → Cloud CRM Agentforce | Tier 1 Telco pages |

To hide a page for a specific call, remove its entry from `demo-ui/fixtures.json` before starting the server. Restore from `git checkout demo-ui/fixtures.json` after.

---

## 3. On-call setup (do in order)

- [ ] **Unlock the bucket** — `demo-unlock` → verify with `demo-check` → should return `HTTP/1.1 200 OK`
- [ ] **Start the demo UI** — `cd demo-ui && node server.js`
- [ ] **Open the demo URL** in Chrome — set zoom to **90%** so all three scenario panels are visible without scrolling
- [ ] **Pre-load the first page** you plan to demo (click the fixture button but don't Run Test yet) — avoids a cold-start pause on the first live run
- [ ] **Hide the terminal** — customer does not need to see it
- [ ] **Close unrelated tabs**
- [ ] **Silence notifications** — Slack, mail, calendar alerts
- [ ] **Have the repo README open** in a background tab as a fallback reference

---

## 4. Known POC caveats — acknowledge these in-demo, don't hide them

**Caching (Scenario C shows Cache Miss, not Cache Hit)**
Without Harper enabled, the EdgeWorker re-executes the Fermyon Wasm function on every bot request — Akamai does not cache `responseProvider` responses automatically without additional property configuration. Frame it: *"We left the cache transparent so you can watch the full pipeline execute live. In production, Harper pre-populates the cache so returning crawlers get a sub-millisecond hit."*

**Header-based bot trigger**
The demo uses `X-Verified-Bot: true` set by Akamai's Bot Manager property rule. In production this header is injected by the platform for verified crawlers — GPTBot, ClaudeBot, PerplexityBot. It is not something an end user or attacker can spoof to get Markdown instead of HTML. The demo UI adds the header client-side to simulate verified bot traffic.

---

## 5. Recovery playbook

### ❌ Wasm function returns 500 / Scenario B shows HTML instead of Markdown

Akamai EdgeWorker has Continue-on-Error enabled. A Wasm failure silently falls back to HTML — Scenario B will look identical to Scenario A.

**Detect:** No `x-wasm-execution: success` header. Content-Type is `text/html`.

**Recovery (fast):** Acknowledge the fallback is working as designed ("the edge is safe-failing to HTML"), pivot to the token comparison metrics which come from pre-computed fixtures and don't require a live Wasm call. Token numbers are still accurate.

**Recovery (fix):** After the call — `cd akamai-ai-markdown && spin build && spin deploy`. Confirm Fermyon shows the function active at `https://cloud.fermyon.com`.

---

### ❌ Linode origin slow or returning errors (Scenario A shows 5xx)

The origin is down or degraded. All three scenarios may fail since both human and bot traffic ultimately touch Linode.

**Detect:** `demo-check` returns non-200 AND it's not a lock issue.

**Recovery (fast):** If the bucket direct URL (`http://serverless-ai-seo-pipeline.website-us-ord-1.linodeobjects.com/index.html`) returns an error, it's a Linode-side issue. Pivot to the pre-recorded demo screenshots or the Claude Design slide deck. The token metrics slides do not require a live origin.

**Recovery (fix):** Check [Linode status page](https://status.linode.com). If us-ord-1 is degraded, wait for recovery — no operator action needed unless files need re-uploading.

---

### ❌ Fixture returns 403 — bucket left locked

The bucket was not unlocked before the call. All fixture URLs return 403-as-Markdown (visible in the Markdown sample panel as an AccessDenied error body).

**Detect:** Markdown sample shows `403 Forbidden` / `AccessDenied` / `BucketName: serverless-ai-seo-pipeline`.

**Recovery (fast, mid-demo):** Mute yourself, run `demo-unlock` in the terminal, wait 5 seconds, re-run the test in the UI. Tell the customer: *"Let me refresh the connection."* This takes under 15 seconds.

**Recovery (prevent):** `demo-prep.sh` catches this in the bucket check section. A green smoke test means the bucket was open at test time.

---

## 6. After the call

- [ ] `demo-lock` — lock the bucket
- [ ] `demo-check` — confirm `403 Forbidden`
- [ ] Kill the demo server (Ctrl+C)
- [ ] If you edited `fixtures.json` for this call: `git checkout demo-ui/fixtures.json`
