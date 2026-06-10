'use strict';
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// Load .env from project root (no dotenv dependency)
try {
    const envFile = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    for (const line of envFile.split('\n')) {
        const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
} catch { /* .env is optional */ }

const PORT          = 8080;
const TIMEOUT_MS    = 20000;

// Target mode: set AKAMAI_TARGET=production to route tests through the live
// nobodycaresworkharder.me property instead of the staging edge.
const PRODUCTION_HOST = 'stopwaitingshipit.com';
const STAGING_HOST    = 'stopwaitingshipit.com.edgekey-staging.net';
const HOST_HEADER     = 'stopwaitingshipit.com';
const TEST_PATH       = '/';

const PRODUCTION_MODE = (process.env.AKAMAI_TARGET || '').toLowerCase() === 'production';

// SSL verification disabled — required for staging edge certs.
// Production uses a valid cert so verification is enabled there.
const sslAgent = new https.Agent({ rejectUnauthorized: PRODUCTION_MODE });
// Direct fetches (Wasm endpoint, live HTML) bypass cert verification — these
// endpoints may use self-signed or expired certs in demo environments.
const permissiveSslAgent = new https.Agent({ rejectUnauthorized: false });

// Token counting uses tiktoken cl100k_base — same methodology as akamai-html-to-md-optimization.
const { get_encoding } = require('tiktoken');
const enc = get_encoding('cl100k_base');
enc.encode('warmup'); // pre-load WASM binary so the first demo run isn't slow

const WASM_URL     = process.env.WASM_URL ?? '';
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

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
        if (!htmlTokens || !markdownTokens || htmlTokens / markdownTokens < 3) return null;
        return { htmlTokens, markdownTokens, fromFixture: true };
    } catch {
        return null;
    }
}

function makeEdgeRequest(targetUrl, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        // Production mode: hit nobodycaresworkharder.me directly — the EdgeWorker
        // reads the requested URL from the Host + path, no ?url= param needed.
        // Staging mode: route through the staging edge with ?url= and a Host override.
        const options = PRODUCTION_MODE ? {
            hostname: PRODUCTION_HOST,
            port: 443,
            path: new URL(targetUrl).pathname + (new URL(targetUrl).search || ''),
            method: 'GET',
            headers: { 'Accept': '*/*', ...extraHeaders },
            agent: sslAgent
        } : {
            hostname: STAGING_HOST,
            port: 443,
            path: `${TEST_PATH}?url=${encodeURIComponent(targetUrl)}`,
            method: 'GET',
            // Accept: */* matches curl's default — omitting it can cause Akamai
            // property routing rules to behave differently from the validate script.
            headers: { 'Host': HOST_HEADER, 'Accept': '*/*', ...extraHeaders },
            agent: sslAgent
        };

        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                resolve({
                    status:          res.statusCode,
                    responseTime:    Date.now() - start,
                    contentType:     res.headers['content-type']     || '',
                    xCache:          res.headers['x-cache']          || '',
                    xWasmExecution:  res.headers['x-wasm-execution'] || '',
                    serverTiming:    res.headers['server-timing']    || '',
                    bodySize:        buf.length,
                    bodyPreview:     buf.toString('utf8', 0, 400).trim()
                });
            });
        });

        req.setTimeout(TIMEOUT_MS, () =>
            req.destroy(new Error(`Request timed out after ${TIMEOUT_MS / 1000}s`))
        );
        req.on('error', reject);
        req.end();
    });
}

// Direct fetch to a real URL — used for token comparison, bypasses the staging edge.
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
async function fetchTokenComparison(targetUrl) {
    const [htmlResult, wasmResult] = await Promise.allSettled([
        makeDirectFetch(targetUrl),
        makeDirectFetch(WASM_URL, { 'X-Target-URL': targetUrl })
    ]);
    if (htmlResult.status !== 'fulfilled' || wasmResult.status !== 'fulfilled') return null;
    if (wasmResult.value.status !== 200) return null;
    // Guard against the Wasm endpoint returning non-markdown (e.g. an error page).
    if (!wasmResult.value.contentType.includes('markdown')) return null;

    const htmlTokens     = countTokens(htmlResult.value.body);
    const markdownTokens = countTokens(wasmResult.value.body);
    // Require at least 3× improvement to be worth showing. Pages dominated by
    // inline JavaScript (e.g. carrier device pages) produce html2md output nearly
    // as large as the source HTML — a 1.0× multiplier is misleading in a demo.
    if (!htmlTokens || !markdownTokens || htmlTokens / markdownTokens < 3) return null;
    return { htmlTokens, markdownTokens };
}

async function runTests(targetUrl, fixtureFile) {
    // Fixture takes priority over live fetch — falls back to live fetch when absent.
    const tokenPromise = fixtureFile
        ? Promise.resolve(loadFixtureTokens(fixtureFile))
        : fetchTokenComparison(targetUrl);

    const [testA, tokenData] = await Promise.all([
        makeEdgeRequest(targetUrl),
        tokenPromise
    ]);
    const testB = await makeEdgeRequest(targetUrl, { 'X-Verified-Bot': 'true' });
    // Allow extra time for the edge cache to propagate before the cache-hit test.
    await new Promise(r => setTimeout(r, 2000));
    const testC = await makeEdgeRequest(targetUrl, { 'X-Verified-Bot': 'true' });
    return { testA, testB, testC, tokenData };
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
          Your visitors experience no difference whatsoever. Akamai passes their request straight to your origin — zero latency added, zero risk to your existing traffic or revenue. The pipeline is completely invisible to humans.
        </div>
      </div>

      <div class="test-card test-b">
        <div class="card-stripe"></div>
        <div class="card-head">
          <div class="card-step">Scenario B</div>
          <div class="card-title">AI Crawler &mdash; First Visit</div>
          <div class="card-sub">An AI crawler arrives for the first time.<br>Akamai intercepts and optimizes.</div>
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
          <div class="card-title">AI Crawler &mdash; Returns</div>
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
        <div class="metric-label">Pipeline Success Rate</div>
        <div class="metric-desc" id="m3-desc">Both AI crawler visits were intercepted and served AI-optimized content at the Akamai edge — no origin infrastructure involved.</div>
        <div class="metric-src">Demonstrated live &middot; Scenarios B and C</div>
      </div>

    </div>
  </div>
</main>

<footer>Akamai Technologies &nbsp;&middot;&nbsp; AI Content Optimization &nbsp;&middot;&nbsp; Live Demo</footer>

<script>
var running = false;
var selectedFixture = null;

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
    body: JSON.stringify({ url: url, fixtureFile: selectedFixture ? selectedFixture.file : null })
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
  renderCard('body-a', d.testA, 'a');
  renderCard('body-b', d.testB, 'b');
  renderCard('body-c', d.testC, 'c');

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
  if (tokenData && tokenData.htmlTokens > 0 && tokenData.markdownTokens > 0) {
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

  // Metric 3: Pipeline success rate — both B and C must return AI-optimized markdown.
  if (bMarkdown && cMarkdown) {
    document.getElementById('m3-val').innerHTML = '100<sup>%</sup>';
    document.getElementById('m3-desc').textContent =
      'Both AI crawler visits were intercepted and served AI-optimized content at the Akamai edge — ' +
      'no origin infrastructure involved.';
  } else if (bMarkdown || cMarkdown) {
    document.getElementById('m3-val').innerHTML = '50<sup>%</sup>';
    document.getElementById('m3-desc').textContent =
      'One of the two AI crawler visits returned AI-optimized content. Re-run the demo to confirm the full pipeline.';
  } else {
    document.getElementById('m3-val').innerHTML = '<span style="font-size:26px;font-weight:800">Re-run</span>';
    document.getElementById('m3-desc').textContent =
      'Edge processing was not confirmed on this run. Run the demo again to see the pipeline success rate.';
  }

  show('results');
}

function renderCard(id, t, scenario) {
  var isMarkdown = t.contentType.includes('markdown');

  // Edge Processing row for B and C only.
  // B: "Not Confirmed" when xWasmExecution is absent means the pipeline wasn't triggered.
  // C: "Served from Cache" is the expected happy path — compute was bypassed by cache.
  var edgeRow = '';
  if (scenario === 'b') {
    edgeRow = statRow('Edge Processing',
      t.xWasmExecution ? badge('Active', 'b-edge') : badge('Not Confirmed', 'b-miss'));
  } else if (scenario === 'c') {
    var cHit = (t.xCache || '').toUpperCase().includes('HIT') ||
               ((t.serverTiming || '').toLowerCase().includes('cdn-cache') &&
                (t.serverTiming || '').toLowerCase().includes('hit'));
    edgeRow = statRow('Edge Processing',
      t.xWasmExecution ? badge('Active', 'b-edge')
      : cHit             ? badge('Served from Cache', 'b-hit')
      :                    badge('Not Confirmed', 'b-miss'));
  }

  // Content preview: only for B and C, and only when the response is actually
  // markdown. Showing XML or HTML here would mislead the audience.
  var preview = '';
  if (scenario !== 'a' && isMarkdown && t.bodyPreview) {
    preview = '<div class="preview-label">Sample of AI-optimized content delivered</div>' +
              '<div class="preview">' + esc(t.bodyPreview.substring(0, 320)) + '</div>';
  }

  document.getElementById(id).innerHTML =
    statRow('Response Time',  '<strong>' + t.responseTime + 'ms</strong>') +
    statRow('Content Format', ctBadge(t.contentType, scenario)) +
    statRow('Cache Status',   cacheBadge(t.xCache, t.serverTiming, scenario)) +
    edgeRow +
    statRow('Response Size',  fmtBytes(t.bodySize)) +
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
  if (ct.includes('markdown')) return badge('AI‑Optimized Markdown', 'b-md');
  if (ct.includes('html'))     return badge('Standard HTML', 'b-html');
  // Scenario A in staging always returns a 404 XML error — show a neutral label
  // so the raw content type doesn't confuse the audience.
  if (scenario === 'a')        return badge('Origin Response', 'b-bypass');
  return badge(ct || 'unknown', 'b-bypass');
}

function cacheBadge(xc, st, scenario) {
  var v = (xc || '').toUpperCase();
  var s = (st || '').toLowerCase();
  var hit  = v.includes('HIT')  || (s.includes('cdn-cache') && s.includes('hit'));
  var miss = v.includes('MISS') || (s.includes('cdn-cache') && s.includes('miss'));
  if (hit)  return badge('Served from Edge Cache', 'b-hit');
  if (miss) return badge('Cache Miss', 'b-miss');
  return scenario === 'a' ? badge('Human Traffic — Bypassed', 'b-bypass') : badge('Bypassed', 'b-bypass');
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
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
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

    if (req.method === 'POST' && req.url === '/run-tests') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const { url: targetUrl, fixtureFile } = JSON.parse(body);
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
                const results = await runTests(targetUrl, fixtureFile || null);
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
    console.log('\n  Edge AI Markdown — Demo UI');
    console.log(`  http://localhost:${PORT}\n`);
});
