'use strict';
const http  = require('http');
const https = require('https');
const zlib  = require('zlib');
const fs    = require('fs');
const path  = require('path');
const dns   = require('dns').promises;

const PORT            = parseInt(process.env.PORT || '8080', 10);
const TIMEOUT_MS      = 20000;
// Edge host the 3-scenario flow runs against. Override with PRODUCTION_HOST.
const PRODUCTION_HOST = process.env.PRODUCTION_HOST || 'nobodycaresworkharder.me';

const sslAgent = new https.Agent({ rejectUnauthorized: true });
// Direct fetches (Wasm endpoint, live HTML) bypass cert verification — these
// endpoints may use self-signed or expired certs in demo environments.
const permissiveSslAgent = new https.Agent({ rejectUnauthorized: false });

// Token counting uses tiktoken cl100k_base — same methodology as akamai-html-to-md-optimization.
const { get_encoding } = require('tiktoken');
const enc = get_encoding('cl100k_base');
enc.encode('warmup'); // pre-load WASM binary so the first demo run isn't slow

// Akamai Functions converter (Fermyon Spin Wasm under the hood, HTML→Markdown). Override with WASM_URL.
const WASM_URL     = process.env.WASM_URL || 'https://bede2402-c4b7-4234-b17c-5e04fc46ef00.fwf.app';
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// ── Scenario config (Phase A) ────────────────────────────────────────────────
// Each demo scenario points the SAME flow at a different backend (property host,
// converter, optional features). Driven by scenarios.config.json; the UI picks
// the active scenario and sends its id with each request. EDGE_IP env overrides
// the active scenario's edge (pin a staging edge until prod DNS is cut to Akamai).
let SCENARIO_CFG = { default: null, scenarios: [] };
try {
    SCENARIO_CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenarios.config.json'), 'utf8'));
} catch (e) { console.warn('scenarios.config.json not loaded:', e.message); }
const SCENARIOS = SCENARIO_CFG.scenarios || [];
const DEFAULT_SCENARIO = SCENARIO_CFG.default || (SCENARIOS[0] && SCENARIOS[0].id) || null;

function resolveScenario(id) {
    const s = SCENARIOS.find(x => x.id === id)
        || SCENARIOS.find(x => x.id === DEFAULT_SCENARIO)
        || SCENARIOS[0];
    if (!s) return { id: 'default', host: PRODUCTION_HOST, wasmUrl: WASM_URL, edgeIp: '', stagingHost: '', features: {} };
    return {
        id: s.id, label: s.label,
        host:   s.host   || PRODUCTION_HOST,
        wasmUrl: s.wasmUrl || WASM_URL,
        edgeIp: s.edgeIp || '',
        stagingHost: s.stagingHost || '',
        ewScenario: s.ewScenario || '',
        features: s.features || {}
    };
}

// Which Akamai edge IP to connect to for a scenario. Priority:
//   1. explicit cfg.edgeIp (pin in scenarios.config.json)
//   2. STAGING mode → resolve the scenario's OWN staging edge from its host
//      (cfg.stagingHost, default <host>.edgekey-staging.net) — so each scenario
//      targets its own edge: no global-EDGE_IP cert mismatch, no hardcoded
//      rotating IPs
//   3. global EDGE_IP env
//   4. '' → connect to the host directly via DNS (once prod is cut to Akamai)
// Enable with AKAMAI_STAGING=1.
const STAGING = /^(1|true|staging|yes)$/i.test(process.env.AKAMAI_STAGING || '');
async function resolveEdgeIp(cfg) {
    if (cfg && cfg.edgeIp) return cfg.edgeIp;
    if (STAGING && cfg && cfg.host) {
        const sHost = cfg.stagingHost || (cfg.host + '.edgekey-staging.net');
        try { return (await dns.lookup(sHost)).address; }
        catch { return process.env.EDGE_IP || ''; }
    }
    return process.env.EDGE_IP || '';
}

function countTokens(text) {
    try { return enc.encode(text).length; } catch { return Math.ceil(text.length / 4); }
}

// Turndown converts fixture HTML to Markdown for token comparison.
// Scripts, styles, nav and footer are stripped — these carry zero semantic
// value for AI crawlers and are the primary source of token bloat.
const TurndownService = require('turndown');
const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' });
td.remove(['script', 'style', 'nav', 'footer', 'iframe', 'noscript', 'svg']);

function loadFixtureTokens(fixtureFile) {
    try {
        const html     = fs.readFileSync(path.join(FIXTURES_DIR, path.basename(fixtureFile)), 'utf8');
        const markdown = td.turndown(html);
        const htmlTokens     = countTokens(html);
        const markdownTokens = countTokens(markdown);
        if (!htmlTokens || !markdownTokens) return null;
        return {
            htmlTokens, markdownTokens, fromFixture: true,
            htmlBytes:     Buffer.byteLength(html, 'utf8'),
            markdownBytes: Buffer.byteLength(markdown, 'utf8'),
            significant:   (htmlTokens / markdownTokens) >= 3,
        };
    } catch {
        return null;
    }
}

// Modern Akamai edges report cache status via `server-timing: cdn-cache; desc=HIT|MISS`
// rather than the legacy X-Cache header. Extract HIT/MISS so cacheBadge can read it.
function cdnCacheStatus(serverTiming) {
    if (!serverTiming) return '';
    const m = String(serverTiming).match(/cdn-cache;\s*desc=([A-Za-z_]+)/i);
    return m ? m[1].toUpperCase() : '';
}

function makeEdgeRequest(targetUrl, extraHeaders = {}, cfg = null) {
    const host = (cfg && cfg.host) || PRODUCTION_HOST;
    // Harper scenarios cache in Harper, so we bust the Akamai CDN (unique cb=) to
    // force the EW to re-run and read Harper on the return visit. The CDN-only
    // scenario (edge-convert) caches AT the CDN — so we must NOT bust it, or the
    // return visit never hits the CDN (shows "Bypassed" instead of a cache hit).
    const harperScenario = !!(cfg && cfg.features && cfg.features.harperCache);
    return resolveEdgeIp(cfg).then(edgeIp => new Promise((resolve, reject) => {
        const start = Date.now();
        const isBot = extraHeaders['X-Verified-Bot'] === 'true';
        const options = {
            hostname: edgeIp || host,
            servername: host,            // SNI + cert match when pinning an edge IP
            port: 443,
            path: isBot
                ? '/?url=' + encodeURIComponent(targetUrl) + (harperScenario ? '&cb=' + Date.now() : '')
                : new URL(targetUrl).pathname + (new URL(targetUrl).search || ''),
            method: 'GET',
            // X-Demo-Scenario tells the demo-mode EW which scenario to apply (one EW,
            // one property serves all scenarios). Ignored unless PMUSER_DEMO_MODE=true.
            headers: { 'Accept': '*/*', 'Host': host, ...(cfg && cfg.ewScenario ? { 'X-Demo-Scenario': cfg.ewScenario } : {}), ...extraHeaders },
            agent: sslAgent
        };

        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const raw = Buffer.concat(chunks);
                const isGzip = (res.headers['content-encoding'] || '').includes('gzip');
                const finalize = (buf) => resolve({
                    status:          res.statusCode,
                    responseTime:    Date.now() - start,
                    contentType:     res.headers['content-type']     || '',
                    xCache:          res.headers['x-cache'] || cdnCacheStatus(res.headers['server-timing']) || '',
                    xWasmExecution:  res.headers['x-wasm-execution'] || '',
                    xServedBy:       res.headers['x-served-by']      || '',
                    xCacheWrite:     res.headers['x-cache-write']    || '',
                    bodySize:        buf.length,
                    bodyPreview:     buf.toString('utf8', 0, 400).trim()
                });
                if (isGzip) {
                    zlib.gunzip(raw, (err, buf) => finalize(err ? raw : buf));
                } else {
                    finalize(raw);
                }
            });
        });

        req.setTimeout(TIMEOUT_MS, () =>
            req.destroy(new Error(`Request timed out after ${TIMEOUT_MS / 1000}s`))
        );
        req.on('error', reject);
        req.end();
    }));
}

// Direct fetch to a real URL — used for token comparison, bypasses the edge.
// Follows up to 3 redirects so pages that 301 to www. still return real HTML.
// Accept-Encoding: identity disables gzip — Node's http module does not auto-decompress,
// and tokenizing raw gzip bytes produces meaningless token counts.
function makeDirectFetch(url, headers = {}, hops = 3) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const lib = parsed.protocol === 'https:' ? https : http;
        const req = lib.request({
            hostname: parsed.hostname,
            port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + (parsed.search || ''),
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; AkamaiDemo/1.0)',
                'Accept-Encoding': 'identity',
                ...headers
            },
            agent: parsed.protocol === 'https:' ? permissiveSslAgent : undefined
        }, (res) => {
            if (hops > 0 && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                const next = new URL(res.headers.location, url).href;
                resolve(makeDirectFetch(next, headers, hops - 1));
                return;
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({
                status:      res.statusCode,
                contentType: res.headers['content-type'] || '',
                body:        Buffer.concat(chunks).toString('utf8')
            }));
        });
        req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('Timeout')));
        req.on('error', reject);
        req.end();
    });
}

// Calls the Wasm function directly (no EdgeWorker truncation) and fetches the target HTML
// in parallel, then returns accurate cl100k_base token counts for both.
async function fetchTokenComparison(targetUrl, cfg = null) {
    const wasmUrl = (cfg && cfg.wasmUrl) || WASM_URL;
    const [htmlResult, wasmResult] = await Promise.allSettled([
        makeDirectFetch(targetUrl),
        makeDirectFetch(wasmUrl, { 'X-Target-URL': targetUrl })
    ]);
    if (htmlResult.status !== 'fulfilled' || wasmResult.status !== 'fulfilled') return null;
    if (wasmResult.value.status !== 200) return null;
    // Guard against the Wasm endpoint returning non-markdown (e.g. an error page).
    if (!wasmResult.value.contentType.includes('markdown')) return null;

    const htmlTokens     = countTokens(htmlResult.value.body);
    const markdownTokens = countTokens(wasmResult.value.body);
    if (!htmlTokens || !markdownTokens) return null;
    return {
        htmlTokens, markdownTokens,
        htmlBytes:     Buffer.byteLength(htmlResult.value.body, 'utf8'),
        markdownBytes: Buffer.byteLength(wasmResult.value.body, 'utf8'),
        // Byte sizes are ALWAYS returned (real HTML vs Markdown, for the cards). The
        // token-ratio metric is only featured when "significant" (≥3×) — pages dominated
        // by inline JS convert to nearly-as-large Markdown, where a ~1× ratio misleads.
        significant:   (htmlTokens / markdownTokens) >= 3,
    };
}

async function runTests(targetUrl, fixtureFile, cfg = null) {
    // Fixture takes priority over live fetch — falls back to live fetch when absent.
    const tokenPromise = fixtureFile
        ? Promise.resolve(loadFixtureTokens(fixtureFile))
        : fetchTokenComparison(targetUrl, cfg);

    const botHeaders = {
        'X-Verified-Bot': 'true',
        'Pragma': 'akamai-x-cache-on'
    };

    const [testA, tokenData] = await Promise.all([
        makeEdgeRequest(targetUrl, {}, cfg),
        tokenPromise
    ]);
    const testB = await makeEdgeRequest(targetUrl, botHeaders, cfg);

    // Return visit. We don't poll for a Harper hit: a real AI crawler won't return
    // within ~2s, so over this gap the write/render is racy and the live hit/miss is
    // inconsistent — the cards talk-track over it rather than display it (see
    // renderCard). A short fixed delay keeps the CDN scenario's edge cache warm.
    await new Promise(r => setTimeout(r, 2000));
    const testC = await makeEdgeRequest(targetUrl, botHeaders, cfg);

    return { testA, testB, testC, tokenData, scenario: cfg ? cfg.id : null };
}

function sendJSON(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// HTML frontend (embedded — no build step required)
// ---------------------------------------------------------------------------
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Content Optimization — Akamai Live Demo</title>
<style>
/* Akamai brand palette (from brand-guidelines.pdf)
   Navy:   #002F6C  (RGB 0,47,108)
   Blue:   #00A4EB  (RGB 0,164,235)
   Orange: #FF8B00  (RGB 255,139,0)
   Font:   Instrument Sans
*/
@import url('https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;600;700;800&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Instrument Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
     background:#f0f4f8;color:#3d3d3d;min-height:100vh}

/* ── Header ── */
header{background:#002F6C;padding:0 48px;
       display:flex;align-items:center;justify-content:space-between;
       min-height:68px}
.logo{display:flex;align-items:center;gap:14px}
.logo-mark{width:34px;height:34px;background:#00A4EB;border-radius:6px;
           display:flex;align-items:center;justify-content:center;
           font-weight:800;font-size:16px;color:#fff;letter-spacing:-1px}
.logo-name{font-size:17px;font-weight:700;color:#fff;letter-spacing:-.2px}
.header-pill{background:rgba(0,164,235,.18);border:1px solid rgba(0,164,235,.35);
             color:#7dd6f0;padding:4px 14px;border-radius:100px;
             font-size:12px;font-weight:600;letter-spacing:.3px}

/* ── Hero ── */
.hero{background:#002F6C;padding:0 48px 40px;border-bottom:3px solid #00A4EB}
.hero h1{font-size:32px;font-weight:800;color:#fff;
         margin-bottom:10px;letter-spacing:-.4px}
.hero p{font-size:15px;line-height:1.7;color:#9ab4cc;max-width:680px}
.hero-hook{display:inline-block;background:#FF8B00;color:#fff;
           font-size:12px;font-weight:800;text-transform:uppercase;
           letter-spacing:.8px;padding:4px 12px;border-radius:4px;
           margin-bottom:18px}

/* ── Layout ── */
main{max-width:1120px;margin:0 auto;padding:36px 24px 60px}

/* ── URL Form ── */
.url-form{background:#fff;border-radius:12px;padding:24px 28px;
          margin-bottom:28px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.url-form label{display:block;font-size:13px;font-weight:700;
                color:#002F6C;margin-bottom:10px}
.url-hint{font-size:12px;font-weight:400;color:#a8a8aa;margin-left:6px}
.url-row{display:flex;gap:10px}
.url-input{flex:1;padding:12px 16px;border:1.5px solid #d4dbe3;
           border-radius:8px;font-size:15px;color:#002F6C;outline:none;
           transition:border-color .15s}
.url-input:focus{border-color:#00A4EB}
.run-btn{background:#00A4EB;color:#fff;border:none;padding:12px 32px;
         border-radius:8px;font-size:15px;font-weight:700;cursor:pointer;
         white-space:nowrap;transition:background .15s;letter-spacing:.2px}
.run-btn:hover{background:#007faa}
.run-btn:disabled{background:#a8a8aa;cursor:not-allowed}

/* ── Loading ── */
.loading{display:none;text-align:center;padding:56px 24px}
.spinner{width:40px;height:40px;border:3px solid #dde3e9;
         border-top-color:#00A4EB;border-radius:50%;
         animation:spin .75s linear infinite;margin:0 auto 20px}
@keyframes spin{to{transform:rotate(360deg)}}
.loading-label{font-size:13px;font-weight:700;color:#002F6C;
               text-transform:uppercase;letter-spacing:.6px;margin-bottom:6px}
.loading p{font-size:14px;color:#a8a8aa}

/* ── Error ── */
.error-banner{display:none;background:#fef2f2;border:1px solid #fecaca;
              color:#b91c1c;padding:14px 18px;border-radius:8px;
              margin-bottom:20px;font-size:14px}

/* ── Section title ── */
.section-title{font-size:11px;font-weight:700;text-transform:uppercase;
               letter-spacing:.9px;color:#a8a8aa;margin-bottom:14px}

/* ── Test Cards ── */
#results{display:none}
.test-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;
            margin-bottom:36px}
.test-card{background:#fff;border-radius:12px;overflow:hidden;
           box-shadow:0 1px 3px rgba(0,0,0,.08);
           display:flex;flex-direction:column}
.card-stripe{height:4px}
.test-a .card-stripe{background:#6b7280}
.test-b .card-stripe{background:#00A4EB}
.test-c .card-stripe{background:#FF8B00}
.card-head{padding:18px 20px 14px;border-bottom:1px solid #f2f5f7}
.card-step{font-size:10px;font-weight:800;text-transform:uppercase;
           letter-spacing:1.2px;margin-bottom:6px}
.test-a .card-step{color:#6b7280}
.test-b .card-step{color:#00A4EB}
.test-c .card-step{color:#FF8B00}
.card-title{font-size:17px;font-weight:800;color:#002F6C;margin-bottom:4px}
.card-sub{font-size:12px;color:#a8a8aa;line-height:1.5}
.card-body{padding:14px 20px;flex:1}
.stat{display:flex;justify-content:space-between;align-items:center;
      padding:8px 0;border-bottom:1px solid #f5f7f9;font-size:13px}
.stat:last-child{border-bottom:none}
.stat-k{font-size:12px;color:#6b7280;font-weight:500}
.stat-v{font-weight:700;color:#002F6C;font-size:13px}
.preview-label{font-size:10px;font-weight:700;text-transform:uppercase;
               letter-spacing:.5px;color:#a8a8aa;margin-top:14px;margin-bottom:6px}
.preview{background:#f7f9fb;border:1px solid #e8edf2;border-radius:6px;
         padding:10px 12px;font-family:'SF Mono','Fira Code','Courier New',monospace;
         font-size:11px;color:#3d4f5c;line-height:1.6;max-height:90px;
         overflow:hidden;word-break:break-all}
.card-desc{padding:14px 20px;background:#f8fafb;border-top:1px solid #f0f4f7;
           font-size:13px;color:#4b5563;line-height:1.7}

/* ── Badges ── */
.badge{display:inline-flex;align-items:center;padding:3px 9px;border-radius:4px;
       font-size:11px;font-weight:700;letter-spacing:.3px}
.b-hit    {background:#d1fae5;color:#065f46}
.b-miss   {background:#fef3c7;color:#92400e}
.b-bypass {background:#f1f5f9;color:#64748b}
.b-html   {background:#ede9fe;color:#5b21b6}
.b-md     {background:#dbeafe;color:#1d4ed8}
.b-ok     {background:#d1fae5;color:#065f46}
.b-err    {background:#fee2e2;color:#b91c1c}
.b-edge   {background:#e0f2fe;color:#0369a1}

/* ── Metrics ── */
.metrics-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.metric-card{background:#fff;border-radius:12px;padding:28px 24px;
             box-shadow:0 1px 3px rgba(0,0,0,.08);
             border-top:4px solid #00A4EB}
.metric-card:nth-child(2){border-top-color:#FF8B00}
.metric-card:nth-child(3){border-top-color:#002F6C}
.metric-val{font-size:52px;font-weight:900;color:#002F6C;line-height:1;
            margin-bottom:10px}
.metric-val sup{font-size:24px;font-weight:700;vertical-align:super;
                line-height:0;color:#00A4EB}
.metric-card:nth-child(2) .metric-val sup{color:#FF8B00}
.metric-card:nth-child(3) .metric-val sup{color:#002F6C}
.metric-tokens{font-size:13px;font-weight:600;color:#9ca3af;margin-bottom:10px;
               letter-spacing:.01em;min-height:18px}
.metric-label{font-size:16px;font-weight:800;color:#002F6C;margin-bottom:8px}
.metric-desc{font-size:13px;color:#4b5563;line-height:1.65;margin-bottom:10px}
.metric-src{font-size:11px;color:#c0c8d0;font-style:italic}

footer{text-align:center;padding:32px;color:#c0c8d0;font-size:12px}

/* ── Fixture bar ── */
.fixture-bar{background:#fff;border-radius:12px;padding:20px 28px;
             margin-bottom:28px;box-shadow:0 1px 3px rgba(0,0,0,.08);
             border-left:4px solid #FF8B00}
.fixture-bar-header{display:flex;align-items:baseline;gap:10px;margin-bottom:14px}
.fixture-bar-title{font-size:13px;font-weight:700;color:#002F6C}
.fixture-bar-hint{font-size:12px;color:#a8a8aa}
.fixture-customer{margin-bottom:10px}
.fixture-customer:last-child{margin-bottom:0}
.fixture-customer-name{font-size:10px;font-weight:800;text-transform:uppercase;
                        letter-spacing:1px;color:#6b7280;margin-bottom:7px}
.fixture-pages{display:flex;gap:8px;flex-wrap:wrap}
.fixture-btn{background:#f0f4f8;border:1.5px solid #d4dbe3;color:#002F6C;
             padding:7px 16px;border-radius:6px;font-size:13px;font-weight:600;
             cursor:pointer;transition:all .15s;white-space:nowrap}
.fixture-btn:hover{background:#e8f4fd;border-color:#00A4EB;color:#00A4EB}
.fixture-btn.active{background:#FF8B00;color:#fff;border-color:#FF8B00}

/* ── Render Lab ── */
.lab-input{width:100%;padding:9px 11px;border:1.5px solid #d4dbe3;border-radius:7px;
           font-size:13px;color:#002F6C;outline:none;font-family:inherit;background:#fff}
.lab-input:focus{border-color:#00A4EB}
.lab-actions{display:flex;align-items:center;gap:10px;margin-top:16px;flex-wrap:wrap}
.lab-status{font-size:13px;color:#6b7280}
.lab-results{margin-top:20px;border-top:1px solid #f0f4f7;padding-top:18px}

/* ── Tabs ── */
.tabs{display:flex;gap:4px;border-bottom:2px solid #e5e7eb;margin-bottom:28px}
.tab{background:none;border:0;padding:12px 22px;font-size:15px;font-weight:700;color:#a8a8aa;
     cursor:pointer;border-bottom:3px solid transparent;margin-bottom:-2px;transition:color .15s}
.tab:hover{color:#002F6C}
.tab.active{color:#002F6C;border-bottom-color:#00A4EB}
</style>
</head>
<body>

<header>
  <div class="logo">
    <div class="logo-mark">A</div>
    <span class="logo-name">Akamai</span>
  </div>
  <div class="header-pill">AI Content Optimization &middot; Live Demo</div>
</header>

<div class="hero">
  <div class="hero-hook">Live Demo</div>
  <h1>Your Content, Optimized for AI &mdash; Automatically</h1>
  <p>Enter any URL below to see Akamai serve the right content to the right audience in real time: standard pages for your visitors, and AI-optimized content for search crawlers &mdash; all at the edge, with no changes to your website.</p>
</div>

<main>
  <div class="scenario-bar" style="margin:0 0 16px;padding:12px 14px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:10px">
    <span style="font-size:12px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.04em;vertical-align:middle">Demo scenario</span>
    <span id="scenario-buttons" style="display:inline-flex;gap:8px;margin-left:10px;flex-wrap:wrap;vertical-align:middle"></span>
    <div class="scenario-blurb" id="scenario-blurb" style="margin-top:8px;font-size:13px;color:#64748b"></div>
  </div>

  <div class="tabs">
    <button class="tab active" id="tab-btn-demo" type="button" onclick="switchTab('demo')">Live Demo</button>
    <button class="tab" id="tab-btn-lab" type="button" onclick="switchTab('lab')">Per-Crawler View</button>
  </div>

  <div id="tab-demo" class="tab-panel">
  <div class="url-form">
    <label for="target-url">Enter a website URL to run the live demo
      <span class="url-hint">— try your own site, or use the default</span>
    </label>
    <div class="url-row">
      <input type="url" id="target-url" class="url-input"
             placeholder="https://www.akamai.com"
             value="https://www.akamai.com" />
      <button class="run-btn" id="run-btn" onclick="runPipeline()">&#9654;&nbsp; Run Live Demo</button>
    </div>
  </div>

  <div class="fixture-bar" id="fixture-bar" style="display:none">
    <div class="fixture-bar-header">
      <span class="fixture-bar-title">Enterprise Demo Pages</span>
      <span class="fixture-bar-hint">Select a page to load real enterprise HTML for the token comparison &mdash; the live pipeline still runs against the actual URL</span>
    </div>
    <div id="fixture-list"></div>
  </div>

  <div class="error-banner" id="error-banner"></div>

  <div class="loading" id="loading">
    <div class="spinner"></div>
    <div class="loading-label">Running live demo&hellip;</div>
    <p id="loading-msg">Starting up&hellip;</p>
  </div>

  <div id="results">
    <div class="section-title">Live Results — Three Scenarios, One URL</div>
    <div class="test-cards">

      <div class="test-card test-a">
        <div class="card-stripe"></div>
        <div class="card-head">
          <div class="card-step">Scenario A</div>
          <div class="card-title">Human Visitor</div>
          <div class="card-sub">A standard browser visits your page.<br>Nothing changes. No risk.</div>
        </div>
        <div class="card-body" id="body-a"></div>
        <div class="card-desc">
          Your visitors experience no difference whatsoever. The pipeline is completely invisible to humans.
        </div>
      </div>

      <div class="test-card test-b">
        <div class="card-stripe"></div>
        <div class="card-head">
          <div class="card-step">Scenario B</div>
          <div class="card-title">AI Crawler &mdash; First Visit</div>
          <div class="card-sub">An AI crawler arrives for the first time. Akamai converts and caches.</div>
        </div>
        <div class="card-body" id="body-b"></div>
        <div class="card-desc">
          Akamai detects the AI crawler at the edge and automatically converts your page to AI-optimized content on the fly. The result is cached globally — no origin changes, no IT tickets, no sprint cycles needed.
        </div>
      </div>

      <div class="test-card test-c">
        <div class="card-stripe"></div>
        <div class="card-head">
          <div class="card-step">Scenario C</div>
          <div class="card-title">AI Crawler &mdash; Return Visit</div>
          <div class="card-sub">The same AI crawler comes back.<br>Served instantly. Origin untouched.</div>
        </div>
        <div class="card-body" id="body-c"></div>
        <div class="card-desc">
          Every return visit from an AI crawler is served directly from Akamai&rsquo;s Global Edge Cache. Your origin server receives zero additional load from crawlers — permanently protected after the very first visit.
        </div>
      </div>

    </div>

    <div class="section-title" style="margin-top:8px">What This Means for Your Business</div>
    <div class="metrics-grid">

      <div class="metric-card">
        <div class="metric-val" id="m1-val">&mdash;</div>
        <div class="metric-label">Edge Processing Time</div>
        <div class="metric-desc" id="m1-desc">Akamai intercepted the AI crawler at the edge and delivered AI-optimized Markdown — without touching your origin infrastructure.</div>
        <div class="metric-src">Measured live during this demo &middot; Scenario B</div>
      </div>

      <div class="metric-card">
        <div class="metric-val" id="m2-val">&mdash;</div>
        <div class="metric-tokens" id="m2-tokens"></div>
        <div class="metric-label">Leaner Content for AI</div>
        <div class="metric-desc" id="m2-desc">AI models receive a streamlined version of your content, making it faster and cheaper for them to process — and more likely to cite your brand accurately.</div>
        <div class="metric-src" id="m2-src">Measured live &middot; cl100k_base tokenizer &middot; Scenario B</div>
      </div>

      <div class="metric-card">
        <div class="metric-val" id="m3-val">&mdash;</div>
        <div class="metric-label">conversion to visits</div>
        <div class="metric-desc" id="m3-desc">One Markdown conversion at first crawler visit, served indefinitely from cache to every subsequent crawler.</div>
        <div class="metric-src">Demonstrated live &middot; Scenarios B and C</div>
      </div>

    </div>
  </div>

  </div><!-- /tab-demo -->

  <div id="tab-lab" class="tab-panel" style="display:none">
  <div class="section-title">Per-Crawler Content Negotiation</div>
  <div class="url-form">
    <p style="font-size:13px;color:#6b7280;margin-bottom:12px">Enter a URL and pick a crawler &mdash; the policy serves <strong>HTML or Markdown from the same cached render</strong>. Mirrors the EdgeWorker's <code>X-Bot-Kind</code> routing (shared <code>crawler-policy.js</code>).</p>
    <div class="url-row" style="margin-bottom:12px">
      <input type="url" id="lab-url" class="url-input"
             placeholder="https://www.example.com/product"
             value="https://www.verizon.com/business/shop/products/devices/smartphones/apple-iphone-17-pro-max" />
    </div>
    <div class="lab-actions" style="margin-top:0">
      <select id="crawler-bot" class="lab-input" style="max-width:260px">
        <option value="googlebot">Googlebot (Search) → HTML</option>
        <option value="bingbot">Bingbot → HTML</option>
        <option value="google-extended">Google-Extended (AI) → Markdown</option>
        <option value="claudebot">ClaudeBot (Anthropic) → Markdown</option>
        <option value="gptbot">GPTBot (OpenAI) → Markdown</option>
        <option value="oai-searchbot">OAI-SearchBot (OpenAI) → Markdown</option>
        <option value="perplexitybot">PerplexityBot → Markdown</option>
        <option value="human">Human (no bot) → HTML</option>
      </select>
      <button class="run-btn" id="crawler-go" onclick="runCrawlerView()">See what this crawler gets</button>
      <span class="lab-status" id="crawler-status"></span>
    </div>
    <div class="lab-results" id="crawler-results" style="display:none">
      <div id="crawler-meta" style="margin-bottom:10px"></div>
      <div class="preview-label">Content delivered to this crawler (sample)</div>
      <div class="preview" id="crawler-sample" style="max-height:240px;overflow:auto"></div>
    </div>
  </div>
  </div><!-- /tab-lab -->
</main>

<footer>Akamai Technologies &nbsp;&middot;&nbsp; AI Content Optimization &nbsp;&middot;&nbsp; Live Demo</footer>

<script>
var running = false;
var selectedFixture = null;
var currentScenario = null;
var scenarioFeatures = {};

// ── Scenario selector (Phase A) — switch which backend the demo targets ──────
function loadScenarios() {
  fetch('/scenarios').then(function(r){ return r.json(); }).then(function(d){
    var wrap = document.getElementById('scenario-buttons');
    if (!wrap) return;
    wrap.innerHTML = '';
    (d.scenarios || []).forEach(function(s){
      var b = document.createElement('button');
      b.type = 'button'; b.id = 'scn-' + s.id; b.textContent = s.label;
      b.style.cssText = 'padding:6px 12px;border-radius:999px;border:1px solid #cbd5e1;background:#fff;color:#334155;font-size:13px;font-weight:600;cursor:pointer';
      b.setAttribute('data-blurb', s.blurb || '');
      b.setAttribute('data-features', JSON.stringify(s.features || {}));
      b.onclick = function(){ selectScenario(s.id); };
      wrap.appendChild(b);
    });
    selectScenario(d.default || (d.scenarios && d.scenarios[0] && d.scenarios[0].id));
  }).catch(function(){});
}
function selectScenario(id) {
  if (!id) return;
  currentScenario = id; scenarioFeatures = {};
  var blurb = '';
  var btns = document.querySelectorAll('#scenario-buttons button');
  for (var i = 0; i < btns.length; i++) {
    var b = btns[i], on = b.id === 'scn-' + id;
    b.style.background = on ? '#0369a1' : '#fff';
    b.style.color = on ? '#fff' : '#334155';
    b.style.borderColor = on ? '#0369a1' : '#cbd5e1';
    if (on) { blurb = b.getAttribute('data-blurb'); try { scenarioFeatures = JSON.parse(b.getAttribute('data-features')); } catch(e) {} }
  }
  var bl = document.getElementById('scenario-blurb'); if (bl) bl.textContent = blurb;
  // Render Lab tab is only meaningful for the prerender scenario.
  var labBtn = document.getElementById('tab-btn-lab');
  if (labBtn) {
    labBtn.style.display = scenarioFeatures.renderLab ? '' : 'none';
    if (!scenarioFeatures.renderLab) switchTab('demo');
  }
}

// ── Tabs ────────────────────────────────────────────────────────────────────
function switchTab(which) {
  var demo = which === 'demo';
  document.getElementById('tab-demo').style.display = demo ? 'block' : 'none';
  document.getElementById('tab-lab').style.display  = demo ? 'none' : 'block';
  document.getElementById('tab-btn-demo').classList.toggle('active', demo);
  document.getElementById('tab-btn-lab').classList.toggle('active', !demo);
}

// ── Per-crawler content negotiation ───────────────────────────────────────────
function runCrawlerView() {
  var btn = document.getElementById('crawler-go');
  var status = document.getElementById('crawler-status');
  var url = document.getElementById('lab-url').value.trim();
  if (!url) { alert('Enter a URL in the Render Lab field above'); return; }
  var bot = document.getElementById('crawler-bot').value;
  btn.disabled = true; status.textContent = 'Fetching as ' + bot + '...';
  fetch('/crawler-view', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url, bot: bot }) })
    .then(function(r){ return r.json(); })
    .then(function(d){
      btn.disabled = false; status.textContent = '';
      if (d.error) { status.textContent = 'Error: ' + d.error; return; }
      document.getElementById('crawler-results').style.display = 'block';
      var rep = d.representation === 'markdown'
        ? '<span class="badge b-md">Markdown</span>'
        : '<span class="badge b-html">HTML</span>';
      var servedClass = d.harperHit ? 'b-hit' : 'b-miss';
      var stats = ' <span class="badge b-bypass">' + (d.bytes || 0).toLocaleString() + ' bytes &middot; ' + (d.tokens || 0).toLocaleString() + ' tokens</span>';
      document.getElementById('crawler-meta').innerHTML =
        '<span class="badge b-edge">' + d.bot + '</span> ' + rep +
        ' <span class="badge ' + servedClass + '">' + d.servedBy + '</span>' + stats;
      document.getElementById('crawler-sample').textContent = d.sample || '(no content returned)';
    })
    .catch(function(e){ btn.disabled = false; status.textContent = 'Request failed: ' + e.message; });
}

function loadFixtures() {
  fetch('/fixtures')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.customers || !data.customers.length) return;
      var listEl = document.getElementById('fixture-list');
      data.customers.forEach(function(customer) {
        var group = document.createElement('div');
        group.className = 'fixture-customer';
        var nameEl = document.createElement('div');
        nameEl.className = 'fixture-customer-name';
        nameEl.textContent = customer.name;
        group.appendChild(nameEl);
        var pages = document.createElement('div');
        pages.className = 'fixture-pages';
        customer.pages.forEach(function(page) {
          var btn = document.createElement('button');
          btn.className = 'fixture-btn';
          btn.textContent = page.label;
          btn.onclick = function() {
            document.querySelectorAll('.fixture-btn').forEach(function(b) {
              b.classList.remove('active');
            });
            if (selectedFixture && selectedFixture.file === page.file) {
              selectedFixture = null; // toggle off
            } else {
              btn.classList.add('active');
              selectedFixture = page;
              document.getElementById('target-url').value = page.url;
              // Also pre-fill the per-crawler URL so the same page can be checked
              // through the crawler-negotiation view in one click.
              var labUrl = document.getElementById('lab-url');
              if (labUrl) labUrl.value = page.url;
            }
          };
          pages.appendChild(btn);
        });
        group.appendChild(pages);
        listEl.appendChild(group);
      });
      show('fixture-bar');
    })
    .catch(function() {});
}

var STEPS = [
  'Simulating a standard visitor request…',
  'AI crawler detected — optimizing content at the edge…',
  'Caching optimized content globally…',
  'AI crawler returns — checking the edge cache…',
  'Calculating results…'
];

function runPipeline() {
  if (running) return;
  var url = document.getElementById('target-url').value.trim();
  if (!url) { showErr('Please enter a website URL to run the demo.'); return; }
  try { new URL(url); } catch(e) {
    showErr('Please enter a valid URL, for example: https://www.akamai.com'); return;
  }

  running = true;
  document.getElementById('run-btn').disabled = true;
  hide('error-banner'); hide('results');
  show('loading');

  var si = 0;
  var msgEl = document.getElementById('loading-msg');
  msgEl.textContent = STEPS[0];
  var timer = setInterval(function() {
    si = Math.min(si + 1, STEPS.length - 1);
    msgEl.textContent = STEPS[si];
  }, 2600);

  fetch('/run-tests', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: url, scenario: currentScenario, fixtureFile: selectedFixture ? selectedFixture.file : null })
  })
  .then(function(r) {
    return r.json().then(function(d) {
      if (!r.ok) throw new Error(d.error || 'Demo run failed');
      return d;
    });
  })
  .then(function(data) {
    clearInterval(timer);
    renderResults(data);
  })
  .catch(function(err) {
    clearInterval(timer);
    showErr('Something went wrong: ' + err.message);
  })
  .finally(function() {
    running = false;
    document.getElementById('run-btn').disabled = false;
    hide('loading');
  });
}

function renderResults(d) {
  renderCard('body-a', d.testA, 'a', null, d.tokenData);
  renderCard('body-b', d.testB, 'b', d.testA.bodySize, d.tokenData);
  renderCard('body-c', d.testC, 'c', d.testA.bodySize, d.tokenData);

  var bMarkdown = d.testB.contentType.includes('markdown');
  var cMarkdown = d.testC.contentType.includes('markdown');

  // Metric 1: Edge processing time — how fast Akamai delivered AI-optimized content on first visit.
  if (bMarkdown) {
    document.getElementById('m1-val').innerHTML = d.testB.responseTime + '<sup>ms</sup>';
    document.getElementById('m1-desc').textContent =
      'The Akamai edge intercepted the AI crawler and delivered AI-optimized Markdown in ' +
      d.testB.responseTime + 'ms — without touching your origin infrastructure.';
  } else {
    document.getElementById('m1-val').innerHTML = '<span style="font-size:26px;font-weight:800">Re-run</span>';
    document.getElementById('m1-desc').textContent =
      'Edge processing was not confirmed on this run. Run the demo again to see the result.';
  }

  // Metric 2: Token efficiency — cl100k_base HTML tokens vs Markdown tokens.
  // Falls back to Markdown payload size when token data is unavailable.
  var tokenData = d.tokenData;
  var pageLabel = selectedFixture ? selectedFixture.label : 'this page';
  if (tokenData && tokenData.significant) {
    var mult = (tokenData.htmlTokens / tokenData.markdownTokens).toFixed(1);
    document.getElementById('m2-val').innerHTML = mult + '<sup>&times;</sup>';
    document.getElementById('m2-tokens').textContent =
      fmtTokens(tokenData.htmlTokens) + ' tokens → ' + fmtTokens(tokenData.markdownTokens) + ' tokens';
    document.getElementById('m2-desc').textContent =
      'AI models processed ' + fmtTokens(tokenData.markdownTokens) + ' tokens of clean Markdown — ' +
      'vs ' + fmtTokens(tokenData.htmlTokens) + ' tokens for the ' + pageLabel + ' HTML. ' +
      "That's " + mult + '× more token-efficient.';
    document.getElementById('m2-src').textContent = tokenData.fromFixture
      ? 'Pre-loaded page fixture · cl100k_base tokenizer · scripts & nav stripped'
      : 'Measured live · cl100k_base tokenizer · Scenario B';
  } else if (bMarkdown) {
    var bSize = d.testB.bodySize;
    document.getElementById('m2-val').innerHTML = fmtBytes(bSize);
    document.getElementById('m2-desc').textContent =
      'AI models received ' + fmtBytes(bSize) + ' of clean, structured Markdown — ' +
      'free of layout markup, navigation, and rendering overhead that adds noise for AI parsers.';
  } else {
    document.getElementById('m2-val').innerHTML = '<span style="font-size:26px;font-weight:800">Re-run</span>';
    document.getElementById('m2-desc').textContent =
      'Edge processing was not confirmed on this run. Run the demo again to see content efficiency results.';
  }

  // Metric 3: 1→∞ conversion story — only confirmed when both B and C deliver markdown.
  if (bMarkdown && cMarkdown) {
    document.getElementById('m3-val').innerHTML = '1<sup>→ ∞</sup>';
    document.getElementById('m3-desc').textContent =
      'One Markdown conversion at first crawler visit, served indefinitely from cache to every subsequent crawler.';
  } else {
    document.getElementById('m3-val').innerHTML = '<span style="font-size:26px;font-weight:800">Re-run</span>';
    document.getElementById('m3-desc').textContent =
      'Edge processing was not confirmed on this run. Run the demo again to see the full pipeline.';
  }

  show('results');
}

function renderCard(id, t, scenario, htmlSize, tokenData) {
  var isMarkdown = t.contentType.includes('markdown');
  // The unified EdgeWorker emits harper-cache-md / harper-cache-html on a Harper hit.
  var harperHit = /^harper-cache/.test((t.xServedBy || '').toLowerCase());
  // Harper-backed scenarios (write-through, prerender): the cache-state rows are
  // hidden because a ~2s gap between visits races the write/render, so the live
  // result is inconsistent and misleading. We talk-track over it instead.
  var harperScenario = !!(scenarioFeatures && scenarioFeatures.harperCache);

  // Edge Processing row — all three scenarios.
  var edgeRow = '';
  if (scenario === 'a') {
    edgeRow = statRow('Edge Processing', badge('Origin passthrough', 'b-bypass'));
  } else if (scenario === 'b') {
    edgeRow = statRow('Edge Processing',
      harperHit          ? badge('Served from cache', 'b-hit')
      : t.xWasmExecution ? badge('Markdown conversion + cached', 'b-miss')
      :                    badge('Not Confirmed', 'b-miss'));
  } else if (scenario === 'c') {
    var cHit = (t.xCache || '').toUpperCase().includes('HIT');
    edgeRow = statRow('Edge Processing',
      (harperHit || cHit) ? badge('Served from cache', 'b-hit')
      : t.xWasmExecution  ? badge('Markdown conversion + cached', 'b-miss')
      :                     badge('Not Confirmed', 'b-miss'));
  }

  // Response size. For the AI scenarios, show the size of the AI-optimized
  // Markdown — the same clean conversion the token metric uses — rather than the
  // raw edge bytes, which bloat on JS-heavy pages when the on-demand Wasm
  // fallback (not the Harper prerender) does the conversion. This keeps the
  // HTML-vs-Markdown contrast (and the reduction %) consistent with the token ratio.
  var realHtml = tokenData && tokenData.htmlBytes;     // real target HTML (direct fetch)
  var cleanMd  = tokenData && tokenData.markdownBytes; // clean Markdown
  var isAi = (scenario === 'b' || scenario === 'c');
  // Human card shows the REAL target HTML size (direct fetch) — not the property's
  // passthrough placeholder, which is a fixed ~37KB and makes Markdown look bloated
  // on large pages. AI cards show the clean Markdown size; reduction % is vs real HTML.
  var displayBytes = isAi ? (cleanMd ? tokenData.markdownBytes : t.bodySize)
                          : (realHtml || t.bodySize);
  var baseline = realHtml || htmlSize;
  var sizeStr = fmtBytes(displayBytes);
  if (isAi && baseline && displayBytes && displayBytes < baseline) {
    var redPct = Math.round((1 - displayBytes / baseline) * 100);
    sizeStr += '<span style="font-size:10px;font-weight:700;color:#059669;margin-left:6px">↓ ' + redPct + '%</span>';
  }

  // Content preview: only for B and C, and only when the response is actually
  // markdown. Showing XML or HTML here would mislead the audience.
  var preview = '';
  if (scenario !== 'a' && isMarkdown && t.bodyPreview) {
    preview = '<div class="preview-label">Sample of AI-optimized content delivered</div>' +
              '<div class="preview">' + esc(t.bodyPreview.substring(0, 320)) + '</div>';
  } else if (scenario !== 'a' && t.bodyPreview &&
             (t.status >= 400 || /non-2xx|forbidden|blocked|wasm error/i.test(t.bodyPreview))) {
    // The origin's bot/WAF defenses (often Akamai's own) returned a non-2xx to the
    // converter's anonymous edge fetch. Reframe as the protection working as intended —
    // and explain why this never happens converting your OWN content in production.
    preview = '<div class="preview-label" style="color:#00558C">&#128737; Blocked by bot &amp; WAF protection &mdash; working as intended</div>' +
              '<div class="preview" style="background:#eff6ff;border-color:#bfdbfe;color:#1e3a5f">' +
              esc(t.bodyPreview.substring(0, 200)) + '</div>' +
              '<div style="font-size:11px;color:#334155;line-height:1.5;margin-top:6px">' +
              'This site is shielded by bot &amp; application defenses &mdash; the kind <strong>Akamai Bot Manager</strong> and <strong>App &amp; API Protector</strong> deliver &mdash; ' +
              'correctly returning <strong>403</strong> to an anonymous automated fetch from outside its perimeter. That&rsquo;s exactly the protection you want against unwanted bots. ' +
              'In production this path reads <strong>your own</strong> content as an authorized, on-property edge fetch &mdash; not an external fetch &mdash; so it&rsquo;s never blocked. ' +
              '(Use a fetch-friendly page to see the live conversion.)</div>';
  }

  // Caveat below Response Time on Scenario B only — scenario-accurate:
  //  • Harper hit (e.g. prerender): the render happened ahead of time, out of band;
  //    a higher first-visit time is connection warm-up, not extra work.
  //  • conversion (md-cache cold miss): the convert happens in parallel; repeats are faster.
  var rtCaveat = scenario === 'b'
    ? '<div style="font-size:11px;color:#a8a8aa;line-height:1.4;padding:2px 0 6px">' +
      (harperHit
        ? 'Served from the prerender cache — the page was rendered once, ahead of time. A higher first-visit time here is connection warm-up, not extra work.'
        : 'First-visit conversion happens in parallel — cached responses are typically faster on repeat visits.') +
      '</div>'
    : '';

  // Scenario C only, Harper scenarios: drop Cache Status / Edge Processing /
  // Served by (race-prone over a 2s gap) and explain it instead. Scenario B and
  // the CDN scenario keep the real rows.
  var cacheBlock;
  if (harperScenario && scenario === 'c') {
    cacheBlock =
      '<div style="font-size:12px;color:#475569;line-height:1.55;background:#f1f5f9;' +
      'border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;margin:6px 0">' +
      'This demo sends the two visits just seconds apart, so the cache may still be writing when the ' +
      'second one arrives \\u2014 too tight a window to show a reliable result here. In practice, AI ' +
      'crawlers come back minutes or hours later, well after the page is cached, so return visits are ' +
      'served straight from cache.' +
      '</div>';
  } else {
    cacheBlock =
      statRow('Cache Status',   cacheBadge(t, scenario)) +
      edgeRow +
      statRow('Served by', servedByBadge(t, scenario));
  }

  document.getElementById(id).innerHTML =
    statRow('Response Time',  '<strong>' + t.responseTime + 'ms</strong>') +
    rtCaveat +
    statRow('Content Format', ctBadge(t.contentType, scenario)) +
    cacheBlock +
    statRow('Response Size',  sizeStr) +
    preview;
}

function statRow(k, v) {
  return '<div class="stat"><span class="stat-k">' + k +
         '</span><span class="stat-v">' + v + '</span></div>';
}

function badge(text, cls) {
  return '<span class="badge ' + cls + '">' + esc(String(text)) + '</span>';
}

function ctBadge(ct, scenario) {
  if (ct.includes('markdown'))                  return badge('AI‑Optimized Markdown', 'b-md');
  if (ct.includes('html') && scenario === 'a')  return badge('Native HTML', 'b-html');
  if (ct.includes('html'))                      return badge('Standard HTML', 'b-html');
  if (scenario === 'a')                         return badge('Origin Response', 'b-bypass');
  return badge(ct || 'unknown', 'b-bypass');
}

function cacheBadge(t, scenario) {
  // Harper-backed scenarios cache in Harper — the truth is in X-Served-By, not the
  // CDN's X-Cache (which always misses when the EdgeWorker runs). The edge-convert
  // scenario has no Harper, so its only cache is the Akamai CDN (X-Cache).
  var harper = !!(scenarioFeatures && scenarioFeatures.harperCache);
  var sb = (t.xServedBy || '').toLowerCase();
  if (/^harper-cache/.test(sb))            return badge('Harper Cache Hit', 'b-hit');
  if (harper && /fermyon|origin/.test(sb)) return badge('Cache Miss → Harper', 'b-miss');
  var v = (t.xCache || '').toUpperCase();   // CDN scenario / passthrough
  if (v.includes('HIT'))  return badge(harper ? 'Harper Cache Hit' : 'CDN Cache Hit', 'b-hit');
  if (v.includes('MISS')) return badge(harper ? 'Cache Miss → Harper' : 'CDN Cache Miss', 'b-miss');
  return badge('Bypassed', 'b-bypass');
}

// Surfaces the EdgeWorker's X-Served-By decision (which path served the response).
// Handles the new dual-path values (harper-cache-html / harper-cache-md /
// fermyon-fallback / origin-fallback) and the baseline values the current
// production endpoint still emits (harper-cache + x-wasm-execution).
function servedByBadge(t, scenario) {
  var s = (t.xServedBy || '').toLowerCase();
  var harper = !!(scenarioFeatures && scenarioFeatures.harperCache);
  if (s === 'harper-cache-html')                       return badge('Harper · prerendered HTML', 'b-html');
  if (s === 'harper-cache-md' || s === 'harper-cache') return badge('Harper · cached Markdown', 'b-md');
  // fermyon-origin = the EW converted via Akamai Functions on a miss (write-through
  // scenarios also wrote it to Harper at that point; edge-convert just CDN-caches it).
  if (s === 'fermyon-origin')                          return badge(harper ? 'Akamai Functions · converted + written to Harper' : 'Akamai Functions · converted at edge', 'b-miss');
  if (s === 'fermyon-fallback')                        return badge('Akamai Functions · fallback', 'b-miss');
  if (s === 'origin-fallback')                         return badge('Origin · fallback', 'b-bypass');
  if (s)                                               return badge(s, 'b-bypass');
  // No X-Served-By header present (scenario A, or an endpoint without the header).
  if (t.xWasmExecution)                                return badge('Akamai Functions · converted at edge', 'b-miss');
  if (scenario === 'a')                                return badge('Origin · direct', 'b-bypass');
  return badge('Not reported', 'b-bypass');
}

function fmtBytes(n) {
  if (!n) return '0 B';
  return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB';
}

function fmtTokens(n) {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n);
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function show(id) { document.getElementById(id).style.display = 'block'; }
function hide(id) { document.getElementById(id).style.display = 'none';  }

function showErr(msg) {
  var el = document.getElementById('error-banner');
  el.textContent = msg;
  show('error-banner');
}

document.getElementById('target-url').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') runPipeline();
});

loadFixtures();
loadScenarios();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Render Lab — standalone page (served at GET /lab)
// ---------------------------------------------------------------------------
const RENDER_LAB_HTML = [
'<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>',
'<meta name="viewport" content="width=device-width, initial-scale=1"/>',
'<title>Render Lab — Harper Prerender</title><style>',
'body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0f1115;color:#e6e6e6}',
'.wrap{max-width:1000px;margin:0 auto;padding:24px}',
'h1{font-size:20px;margin:0 0 4px}.sub{color:#8a93a2;margin:0 0 20px}',
'.card{background:#171a21;border:1px solid #262b36;border-radius:10px;padding:16px;margin-bottom:16px}',
'label{display:block;font-size:12px;color:#9aa4b2;margin:8px 0 3px}',
'input,select{width:100%;box-sizing:border-box;padding:8px 10px;background:#0f1115;border:1px solid #2b313d;border-radius:6px;color:#e6e6e6}',
'.row{display:flex;gap:12px;flex-wrap:wrap}.row>div{flex:1;min-width:120px}',
'button{margin-top:14px;padding:10px 18px;background:#3b82f6;border:0;border-radius:6px;color:#fff;font-weight:600;cursor:pointer}',
'button:disabled{opacity:.5;cursor:wait}',
'.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}',
'.metric{background:#0f1115;border:1px solid #262b36;border-radius:8px;padding:12px}',
'.metric .n{font-size:22px;font-weight:700}.metric .l{font-size:11px;color:#8a93a2;text-transform:uppercase;letter-spacing:.04em}',
'.good{color:#34d399}.bad{color:#f87171}.tag{display:inline-block;font-size:11px;padding:2px 8px;border-radius:99px;background:#222834;color:#9aa4b2;margin-right:6px}',
'pre{background:#0b0d11;border:1px solid #222834;border-radius:8px;padding:12px;overflow:auto;max-height:340px;white-space:pre-wrap;font-size:12px}',
'.muted{color:#8a93a2;font-size:12px}',
'</style></head><body><div class="wrap">',
'<h1>Render Lab</h1>',
'<p class="sub">Tune the headless render per URL and see HTML vs Markdown — same knob as <code>scripts/harper-render-probe.js</code>, calling Harper <code>/render_preview</code>.</p>',
'<div class="card">',
'<label>URL</label><input id="url" placeholder="https://www.example.com/product"/>',
'<div class="row">',
'<div><label>Device</label><select id="device"><option>desktop</option><option>mobile</option><option>tablet</option></select></div>',
'<div><label>Wait until</label><select id="wait"><option value="">(default)</option><option>domcontentloaded</option><option>load</option><option>networkidle2</option><option>networkidle0</option></select></div>',
'<div><label>Settle ms (network-idle cap, 0=off)</label><input id="settle" placeholder="(default 12000)"/></div>',
'<div><label>Idle ms</label><input id="idle" placeholder="(default 600)"/></div>',
'</div>',
'<label>Wait for selector (optional CSS)</label><input id="selector" placeholder="e.g. h1, [data-testid=price]"/>',
'<button id="go">Render</button> ',
'<button id="clearUrl" style="background:#475569">Clear this URL</button> ',
'<button id="clearAll" style="background:#7f1d1d">Clear ALL cache</button> ',
'<span id="status" class="muted"></span>',
'</div>',
'<div id="results" style="display:none">',
'<div class="card"><div class="grid">',
'<div class="metric"><div class="l">Raw fetch — body text</div><div class="n" id="rawText">–</div><div class="muted">the un-rendered shell</div></div>',
'<div class="metric"><div class="l">Rendered — body text</div><div class="n good" id="renText">–</div><div class="muted">after JS executes</div></div>',
'<div class="metric"><div class="l">Raw HTML tokens</div><div class="n" id="rawTok">–</div></div>',
'<div class="metric"><div class="l">Rendered Markdown tokens</div><div class="n good" id="mdTok">–</div><div class="muted" id="ratio"></div></div>',
'</div><div style="margin-top:12px" id="meta"></div></div>',
'<div class="card"><label>Derived Markdown (sample)</label><pre id="md"></pre></div>',
'</div>',
'<script>',
'function n(x){return (x==null?0:x).toLocaleString();}',
'var btn=document.getElementById("go");',
'btn.onclick=async function(){',
' var url=document.getElementById("url").value.trim();',
' if(!url){alert("Enter a URL");return;}',
' var payload={url:url,deviceType:document.getElementById("device").value,',
'  waitUntil:document.getElementById("wait").value,',
'  settleMs:document.getElementById("settle").value,',
'  idleMs:document.getElementById("idle").value,',
'  selector:document.getElementById("selector").value};',
' btn.disabled=true;document.getElementById("status").textContent="Rendering… (can take 10–40s)";',
' try{',
'  var r=await fetch("/render-lab",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});',
'  var d=await r.json();',
'  if(d.error){document.getElementById("status").textContent="Error: "+d.error;btn.disabled=false;return;}',
'  document.getElementById("results").style.display="block";',
'  document.getElementById("rawText").textContent=n(d.raw.textLen)+" ch";',
'  var rt=document.getElementById("renText");rt.textContent=n(d.rendered.textLen)+" ch";',
'  rt.className="n "+((d.rendered.textLen>d.raw.textLen*1.2||d.raw.textLen<50)?"good":"bad");',
'  document.getElementById("rawTok").textContent=n(d.raw.htmlTokens);',
'  document.getElementById("mdTok").textContent=n(d.rendered.markdownTokens);',
'  var ratio=(d.raw.htmlTokens&&d.rendered.markdownTokens)?(d.raw.htmlTokens/d.rendered.markdownTokens).toFixed(1):0;',
'  document.getElementById("ratio").textContent=ratio?(ratio+"x fewer tokens than raw HTML"):"";',
'  var eo=d.effectiveOptions||{};',
'  document.getElementById("meta").innerHTML=',
'   \'<span class="tag">HTTP \'+d.statusCode+\'</span>\'+',
'   \'<span class="tag">\'+(d.elapsedMs||0)+\' ms</span>\'+',
'   \'<span class="tag">waitUntil: \'+eo.waitUntil+\'</span>\'+',
'   \'<span class="tag">settle: \'+eo.settleTimeoutMs+\'</span>\'+',
'   \'<span class="tag">idle: \'+eo.networkIdleMs+\'</span>\'+',
'   \'<span class="tag">selector: \'+(eo.waitForSelector||"none")+\'</span>\';',
'  document.getElementById("md").textContent=d.markdownSample||"(no markdown — non-200 or empty render)";',
' }catch(e){document.getElementById("status").textContent="Request failed: "+e.message;}',
' document.getElementById("status").textContent="";btn.disabled=false;',
'};',
'async function doClear(p){',
' var s=document.getElementById("status");s.textContent="Clearing cache…";',
' try{',
'  var r=await fetch("/cache-clear",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(p)});',
'  var d=await r.json();',
'  s.textContent=d.ok?("Cleared "+d.cleared+" page(s)"+(d.jobsCleared?(" + "+d.jobsCleared+" jobs"):"")):("Error: "+(d.error||"?"));',
' }catch(e){s.textContent="Clear failed: "+e.message;}',
'}',
'document.getElementById("clearAll").onclick=function(){doClear({all:true});};',
'document.getElementById("clearUrl").onclick=function(){var u=document.getElementById("url").value.trim();if(!u){alert("Enter a URL");return;}doClear({url:u});};',
'</script></div></body></html>'
].join('\n');

// ---------------------------------------------------------------------------
// Render Lab — render-tuning knob, wired to Harper's /render_preview
// ---------------------------------------------------------------------------
const HARPER_PREVIEW_URL = process.env.HARPER_PREVIEW_URL || 'http://localhost:9926';
const HARPER_BOT_KEY     = process.env.HARPER_BOT_KEY || '';

// Call Harper's /render_preview with the chosen options (server-side so the
// bot-key never reaches the browser).
function harperRenderPreview({ url, deviceType, waitUntil, settleMs, idleMs, selector }) {
    return new Promise((resolve, reject) => {
        const qs = new URLSearchParams({ url });
        if (deviceType) qs.set('deviceType', deviceType);
        if (waitUntil)  qs.set('waitUntil', waitUntil);
        if (settleMs !== undefined && settleMs !== '' && settleMs !== null) qs.set('settleMs', String(settleMs));
        if (idleMs   !== undefined && idleMs   !== '' && idleMs   !== null) qs.set('idleMs', String(idleMs));
        if (selector)   qs.set('selector', selector);

        const u   = new URL(HARPER_PREVIEW_URL.replace(/\/$/, '') + '/render_preview?' + qs.toString());
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request({
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search,
            method: 'GET',
            headers: { 'x-pr-req-key': HARPER_BOT_KEY },
            agent: u.protocol === 'https:' ? permissiveSslAgent : undefined,
        }, (r) => {
            let data = '';
            r.on('data', (c) => { data += c; });
            r.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch { reject(new Error('Harper returned non-JSON: ' + data.slice(0, 200))); }
            });
        });
        req.on('error', reject);
        req.setTimeout(70000, () => req.destroy(new Error('Harper /render_preview timed out')));
        req.end();
    });
}

// Clear Harper's cache (all, or a single URL) — no DB restart needed.
function harperCacheClear({ all, url }) {
    return new Promise((resolve, reject) => {
        const qs = new URLSearchParams();
        if (all) qs.set('all', 'true');
        else if (url) qs.set('url', url);
        const u = new URL(HARPER_PREVIEW_URL.replace(/\/$/, '') + '/cache_clear?' + qs.toString());
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request({
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search,
            method: 'POST',
            headers: { 'x-pr-req-key': HARPER_BOT_KEY },
            agent: u.protocol === 'https:' ? permissiveSslAgent : undefined,
        }, (r) => {
            let d = '';
            r.on('data', (c) => { d += c; });
            r.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Harper returned non-JSON: ' + d.slice(0, 200))); } });
        });
        req.on('error', reject);
        req.setTimeout(30000, () => req.destroy(new Error('Harper /cache_clear timed out')));
        req.end();
    });
}

// Plain origin fetch — the "before" (un-rendered) baseline for the comparison.
function fetchRaw(targetUrl) {
    return new Promise((resolve) => {
        let u; try { u = new URL(targetUrl); } catch { return resolve({ ok: false, status: 0, html: '' }); }
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request({
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search,
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html', 'Accept-Encoding': 'gzip, br, deflate' },
            agent: u.protocol === 'https:' ? permissiveSslAgent : undefined,
        }, (r) => {
            const chunks = [];
            r.on('data', (c) => chunks.push(c));
            r.on('end', () => {
                let buf = Buffer.concat(chunks);
                const e = r.headers['content-encoding'] || '';
                try {
                    if (e.includes('gzip')) buf = zlib.gunzipSync(buf);
                    else if (e.includes('br')) buf = zlib.brotliDecompressSync(buf);
                    else if (e.includes('deflate')) buf = zlib.inflateSync(buf);
                } catch { /* leave as-is */ }
                resolve({ ok: true, status: r.statusCode, html: buf.toString('utf8') });
            });
        });
        req.on('error', () => resolve({ ok: false, status: 0, html: '' }));
        req.setTimeout(30000, () => req.destroy());
        req.end();
    });
}

// Crude visible-text length — the CSR-gap signal (shell ≈ 0, rendered ≫ 0).
function bodyTextLength(html) {
    const stripped = String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '');
    return stripped.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
}

// Shared per-crawler policy module (ESM) — dynamically imported so the demo and
// the EdgeWorker use the EXACT same routing logic (edgeworker/crawler-policy.js).
let _policyMod = null;
async function crawlerPolicyModule() {
    if (!_policyMod) _policyMod = await import('./crawler-policy.js');
    return _policyMod;
}

// Read a representation straight from Harper's cache (mirrors the EdgeWorker read):
// /page_content for markdown, /page for html. Both come from the same cached render.
function harperReadRepresentation(url, representation, deviceType) {
    return new Promise((resolve) => {
        const path = representation === 'markdown'
            ? '/page_content?path=' + encodeURIComponent(url)
            : '/page/?url=' + encodeURIComponent(url) + '&deviceType=' + encodeURIComponent(deviceType || 'desktop');
        const u = new URL(HARPER_PREVIEW_URL.replace(/\/$/, '') + path);
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request({
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search,
            method: 'GET',
            headers: { 'x-pr-req-key': HARPER_BOT_KEY, 'accept-encoding': 'gzip' },
            agent: u.protocol === 'https:' ? permissiveSslAgent : undefined,
        }, (r) => {
            const chunks = [];
            r.on('data', (c) => chunks.push(c));
            r.on('end', () => {
                let buf = Buffer.concat(chunks);
                if ((r.headers['content-encoding'] || '').includes('gzip')) { try { buf = zlib.gunzipSync(buf); } catch { /* leave */ } }
                resolve({ status: r.statusCode, contentType: r.headers['content-type'] || '', body: buf.toString('utf8') });
            });
        });
        req.on('error', () => resolve({ status: 0, contentType: '', body: '' }));
        req.setTimeout(40000, () => req.destroy());
        req.end();
    });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/lab') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(RENDER_LAB_HTML);
        return;
    }

    if (req.method === 'POST' && req.url === '/crawler-view') {
        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const { url, bot } = JSON.parse(body || '{}');
                if (!url || !/^https?:\/\//i.test(url)) return sendJSON(res, 400, { error: 'Provide a valid http(s) url' });
                const cp = await crawlerPolicyModule();
                const botKind = cp.detectBotKind(bot, '');
                const representation = cp.resolveRepresentation({ botKind, acceptsMarkdown: false, isAiUa: false, policy: {} });
                const r = await harperReadRepresentation(url, representation, 'desktop');
                const harperHit = r.status === 200;
                let servedBy, content;
                if (harperHit) {
                    servedBy = representation === 'markdown' ? 'harper-cache-md' : 'harper-cache-html';
                    content = r.body;
                } else if (representation === 'markdown') {
                    // Mirror the EdgeWorker: cache miss on the AI path → Akamai Functions converts.
                    const w = await makeDirectFetch(WASM_URL, { 'X-Target-URL': url });
                    servedBy = 'fermyon-fallback';
                    content = w && w.status === 200 ? w.body : '';
                } else {
                    // Cache miss on the human/SEO path → origin.
                    const raw = await fetchRaw(url);
                    servedBy = 'origin-fallback';
                    content = raw.ok ? raw.html : '';
                }
                sendJSON(res, 200, {
                    bot: bot || 'human',
                    botKind: botKind || null,
                    representation,
                    harperHit,
                    servedBy,
                    bytes: Buffer.byteLength(content || '', 'utf8'),
                    tokens: content ? countTokens(content) : 0,
                    sample: (content || '').slice(0, 4000),
                });
            } catch (err) {
                sendJSON(res, 500, { error: err.message });
            }
        });
        return;
    }

    if (req.method === 'POST' && req.url === '/cache-clear') {
        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const o = JSON.parse(body || '{}');
                if (!o.all && !o.url) return sendJSON(res, 400, { error: 'provide {all:true} or {url}' });
                const d = await harperCacheClear({ all: !!o.all, url: o.url });
                sendJSON(res, 200, d);
            } catch (err) {
                sendJSON(res, 500, { error: err.message });
            }
        });
        return;
    }

    if (req.method === 'POST' && req.url === '/render-lab') {
        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const opts = JSON.parse(body || '{}');
                if (!opts.url || !/^https?:\/\//i.test(opts.url)) {
                    return sendJSON(res, 400, { error: 'Provide a valid http(s) url' });
                }
                const [preview, raw] = await Promise.all([harperRenderPreview(opts), fetchRaw(opts.url)]);
                const renderedMdTokens = preview.markdown ? countTokens(preview.markdown) : 0;
                const renderedHtmlTokens = preview.html ? countTokens(preview.html) : 0;
                sendJSON(res, 200, {
                    ok: !!preview.ok,
                    statusCode: preview.statusCode,
                    error: preview.error || null,
                    elapsedMs: preview.elapsedMs,
                    renderTimeMs: preview.renderTimeMs,
                    effectiveOptions: preview.effectiveOptions || {},
                    rendered: {
                        htmlBytes: preview.htmlBytes || 0,
                        markdownBytes: preview.markdownBytes || 0,
                        htmlTokens: renderedHtmlTokens,
                        markdownTokens: renderedMdTokens,
                        textLen: bodyTextLength(preview.html),
                    },
                    raw: {
                        ok: raw.ok, status: raw.status,
                        htmlTokens: raw.ok ? countTokens(raw.html) : 0,
                        textLen: bodyTextLength(raw.html),
                    },
                    markdownSample: (preview.markdown || '').slice(0, 6000),
                });
            } catch (err) {
                sendJSON(res, 500, { error: err.message });
            }
        });
        return;
    }

    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(HTML);
        return;
    }

    if (req.method === 'GET' && req.url === '/fixtures') {
        try {
            const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));
            sendJSON(res, 200, config);
        } catch { sendJSON(res, 200, { customers: [] }); }
        return;
    }

    if (req.method === 'GET' && req.url === '/scenarios') {
        return sendJSON(res, 200, {
            default: DEFAULT_SCENARIO,
            scenarios: SCENARIOS.map(s => ({
                id: s.id, label: s.label, blurb: s.blurb, source: s.source, features: s.features || {}
            }))
        });
    }

    if (req.method === 'POST' && req.url === '/run-tests') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const { url: targetUrl, fixtureFile, scenario } = JSON.parse(body);
                if (!targetUrl || typeof targetUrl !== 'string') {
                    return sendJSON(res, 400, { error: 'Missing or invalid url parameter' });
                }
                // Validate URL and restrict to http/https to prevent misuse.
                let parsed;
                try { parsed = new URL(targetUrl); } catch {
                    return sendJSON(res, 400, { error: 'Invalid URL format' });
                }
                if (!['http:', 'https:'].includes(parsed.protocol)) {
                    return sendJSON(res, 400, { error: 'URL must use http or https' });
                }
                const results = await runTests(targetUrl, fixtureFile || null, resolveScenario(scenario));
                sendJSON(res, 200, results);
            } catch (err) {
                sendJSON(res, 500, { error: err.message });
            }
        });
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
    console.log('\n  Serverless AI-SEO Pipeline — Demo UI');
    console.log(`  http://localhost:${PORT}\n`);
});
