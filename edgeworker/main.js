import { httpRequest } from 'http-request';
import { createResponse } from 'create-response';
import { TextEncoder } from 'encoding';
import { TransformStream } from 'streams';
import { readMarkdown, urlToKey, harperAuthHeader } from './harper-read.js';
import { fetchFromHarper, fetchHtmlFromHarper } from './harper-client.js';
import { parseCrawlerPolicy, detectBotKind, resolveRepresentation } from './crawler-policy.js';
import { demoPreset } from './demo-presets.js';

// Unified read-only EdgeWorker. One bundle, four scenarios by PMUSER_* config:
//   cdn-cache      HARPER_ENABLED=false                                   → Fermyon → MD (Akamai CDN)
//   md-cache       HARPER_READ_MODE=markdown_cache, WRITE_THROUGH=true     → Fermyon writes Harper on miss
//   convert-cache  HARPER_READ_MODE=page_content,   WRITE_THROUGH=false    → Harper self-populates; Fermyon=fallback
//   prerender      + SERVE_HTML=true + CRAWLER_POLICY                      → HTML+MD per-crawler; origin=HTML fallback
// The EW never writes Harper; the Function does the write-through. Representation
// (HTML vs Markdown) is resolved per-crawler; a verified bot counts as wanting
// Markdown unless a policy maps its botKind otherwise.

const DEFAULT_AI_CRAWLER_UAS = [
    'gptbot', 'oai-searchbot', 'chatgpt-user', 'claudebot', 'claude-web',
    'anthropic-ai', 'perplexitybot', 'google-extended', 'bytespider', 'ccbot', 'cohere-ai',
];
const ORIGIN_PASSTHROUGH_HEADERS = ['content-type', 'content-encoding', 'cache-control', 'last-modified', 'etag', 'vary'];
const MD_HEADERS = { 'Content-Type': ['text/markdown; charset=utf-8'], 'Cache-Control': ['max-age=3600, public'] };

// new ReadableStream({start}) is not constructible in EdgeWorkers; TransformStream is.
function stringToStream(str) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    writer.write(new TextEncoder().encode(str));
    writer.close();
    return readable;
}
function resolveHttpUrl(raw, fallback) {
    const v = (raw ?? '').trim();
    return (/^https?:\/\//i.test(v) || v.startsWith('/')) ? v : fallback;
}
function sanitize(v) { return String(v ?? '').replace(/[\r\n\t]/g, ' ').substring(0, 200); }

export async function responseProvider(request) {
    try {
        const cfg = {
            HARPER_ENABLED:   request.getVariable('PMUSER_HARPER_ENABLED') !== 'false',
            HARPER_URL:       request.getVariable('PMUSER_HARPER_URL') ?? '',
            HARPER_READ_MODE: (request.getVariable('PMUSER_HARPER_READ_MODE') || 'markdown_cache').trim(),
            WRITE_THROUGH:    request.getVariable('PMUSER_WRITE_THROUGH') === 'true',
            SERVE_HTML:       request.getVariable('PMUSER_SERVE_HTML') === 'true',
            HARPER_WRITE_URL: resolveHttpUrl(request.getVariable('PMUSER_HARPER_WRITE_URL'),
                'https://gq4-us-east5-a-1.ai-seo-pipeline.jgeronim-org.harperfabric.com'),
            HARPER_TOKEN:     request.getVariable('PMUSER_HARPER_TOKEN') ?? '',
            // Harper Fabric's data API authenticates with HTTP Basic (user/pass), not
            // Bearer. When these are set, markdown_cache reads + write-through use Basic.
            HARPER_USER:      request.getVariable('PMUSER_HARPER_USER') ?? '',
            HARPER_PASS:      request.getVariable('PMUSER_HARPER_PASS') ?? '',
            HARPER_BOT_KEY:   request.getVariable('PMUSER_HARPER_BOT_KEY') ?? '',
            HARPER_TIMEOUT_MS: parseInt(request.getVariable('PMUSER_HARPER_TIMEOUT_MS') ?? '1500', 10),
            WASM_URL:         resolveHttpUrl(request.getVariable('PMUSER_WASM_URL'),
                'https://977adc68-2ede-4bf3-9b1e-41923fa6d7a9.fwf.app'),
        };

        // Demo mode: one EW on one property serves EVERY scenario, chosen per request
        // via the X-Demo-Scenario header. Gated by PMUSER_DEMO_MODE so it only applies
        // on the demo property — never on a customer property (a request could
        // otherwise flip WRITE_THROUGH / HARPER_ENABLED etc.).
        if (request.getVariable('PMUSER_DEMO_MODE') === 'true') {
            const preset = demoPreset((request.getHeader('x-demo-scenario') ?? [])[0]);
            if (preset) Object.assign(cfg, preset);
        }

        const aiUasRaw = request.getVariable('PMUSER_AI_CRAWLER_UAS') ?? '';
        const aiCrawlerUas = aiUasRaw
            ? aiUasRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
            : DEFAULT_AI_CRAWLER_UAS;
        const crawlerPolicy = parseCrawlerPolicy(request.getVariable('PMUSER_CRAWLER_POLICY') ?? '');

        const acceptsMarkdown = (request.getHeader('accept') ?? []).some((v) => v.includes('text/markdown'));
        const userAgent       = ((request.getHeader('user-agent') ?? [])[0] ?? '').toLowerCase();
        const botKindHeader   = (request.getHeader('x-bot-kind') ?? [])[0];
        const isVerifiedBot   = (request.getHeader('x-verified-bot') ?? []).includes('true');
        const isAiUa          = aiCrawlerUas.some((t) => userAgent.includes(t));
        const botKind         = detectBotKind(botKindHeader, userAgent);
        // Verified bot (Akamai Bot Manager) wants Markdown unless a per-crawler policy
        // maps its botKind otherwise (policy precedence is inside resolveRepresentation).
        const representation  = resolveRepresentation({ botKind, acceptsMarkdown, isAiUa: isAiUa || isVerifiedBot, policy: crawlerPolicy });

        let targetUrl = null;
        if (request.query) {
            const m = request.query.match(/url=([^&]+)/);
            if (m) targetUrl = decodeURIComponent(m[1]);
        }
        if (!targetUrl) {
            const host = (request.getHeader('host') ?? [])[0] ?? request.host;
            targetUrl = 'https://' + host + request.path;
        }
        if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;

        if (representation === 'markdown') return await serveMarkdown(targetUrl, cfg, botKind);
        if (cfg.SERVE_HTML)               return await serveHtml(targetUrl, cfg, botKind);
        // MD-only scenarios: humans / SEO bots are not intercepted — pass through to origin.
        return createResponse(200, {}, '');

    } catch (error) {
        return createResponse(500, { 'X-Wasm-Execution': ['crashed'], 'Cache-Control': ['no-store'] }, `EdgeWorker Error: ${error.message}`);
    }
}

// ── Markdown path: Harper read (by mode) → Fermyon (+ gated write-through) ──────
async function serveMarkdown(targetUrl, cfg, botKind) {
    if (!cfg.HARPER_ENABLED || !cfg.HARPER_URL) {
        return await fermyonMarkdown(targetUrl, cfg, botKind, null);  // cdn-cache
    }

    let read;
    if (cfg.HARPER_READ_MODE === 'markdown_cache') {
        read = await readMarkdown('markdown_cache', targetUrl,
            { baseUrl: cfg.HARPER_URL,
              authHeader: harperAuthHeader({ user: cfg.HARPER_USER, pass: cfg.HARPER_PASS, token: cfg.HARPER_TOKEN }),
              timeoutMs: cfg.HARPER_TIMEOUT_MS }, httpRequest);
    } else { // page_content (Harper self-populating backends)
        read = await fetchFromHarper(targetUrl,
            { baseUrl: cfg.HARPER_URL, token: cfg.HARPER_TOKEN, botKey: cfg.HARPER_BOT_KEY || undefined, timeoutMs: cfg.HARPER_TIMEOUT_MS }, httpRequest);
    }

    if (read.ok) {
        // markdown_cache returns a parsed string; page_content streams the body.
        const body = read.markdown != null ? stringToStream(read.markdown) : read.response.body;
        return createResponse(200, { ...MD_HEADERS, 'X-Served-By': ['harper-cache-md'], 'X-Bot-Kind': [botKind || 'none'] }, body);
    }
    return await fermyonMarkdown(targetUrl, cfg, botKind, read.reason);
}

async function fermyonMarkdown(targetUrl, cfg, botKind, readReason) {
    const headers = { 'X-Target-URL': [targetUrl] };
    if (cfg.WRITE_THROUGH) {
        headers['X-Harper-Url']           = [cfg.HARPER_WRITE_URL];
        // Forward the full Authorization the converter should use for the Harper PUT
        // (Basic for Harper Fabric). X-Harper-Token kept for back-compat with an older
        // converter that still builds `Bearer <token>` itself.
        headers['X-Harper-Authorization'] = [harperAuthHeader({ user: cfg.HARPER_USER, pass: cfg.HARPER_PASS, token: cfg.HARPER_TOKEN })];
        headers['X-Harper-Token']         = [cfg.HARPER_TOKEN];
        headers['X-Harper-Key']           = [urlToKey(targetUrl)];
        headers['X-Harper-Cached-At']     = [new Date().toISOString()];
    }
    const wasm = await httpRequest(cfg.WASM_URL, { method: 'GET', headers });

    if (!wasm.ok) {
        const err = await wasm.text();
        const h = { 'X-Wasm-Execution': ['failed'], 'Cache-Control': ['no-store'], 'X-EW-Version': ['2.2.0'] };
        if (readReason) h['X-Harper-Read-Reason'] = [readReason];
        return createResponse(500, h, `Wasm Error: ${err}`);
    }

    // Fermyon is the SOURCE for cdn + write-through; a FALLBACK for Harper-backend scenarios.
    const harperBackend = cfg.HARPER_ENABLED && cfg.HARPER_URL && !cfg.WRITE_THROUGH;
    const out = {
        ...MD_HEADERS,
        'X-Wasm-Execution': ['success'],
        'X-Served-By':      [harperBackend ? 'fermyon-fallback' : 'fermyon-origin'],
        'X-Cache-Write':    [cfg.WRITE_THROUGH ? ((wasm.getHeader('X-Harper-Write') ?? ['unknown'])[0] ?? 'unknown') : 'skip'],
        'X-Bot-Kind':       [botKind || 'none'],
        'X-EW-Version':     ['2.2.0'],
    };
    if (readReason) out['X-Harper-Read-Reason'] = [readReason];
    return createResponse(200, out, wasm.body);
}

// ── HTML path (prerender): Harper /page → origin HTML fallback ─────────────────
async function serveHtml(targetUrl, cfg, botKind) {
    if (cfg.HARPER_ENABLED && cfg.HARPER_URL) {
        const result = await fetchHtmlFromHarper(targetUrl,
            { baseUrl: cfg.HARPER_URL, token: cfg.HARPER_TOKEN, botKey: cfg.HARPER_BOT_KEY || undefined, timeoutMs: cfg.HARPER_TIMEOUT_MS }, httpRequest);
        if (result.ok) {
            return createResponse(200, {
                'Content-Type':  ['text/html; charset=utf-8'],
                'Cache-Control': ['max-age=3600, public'],
                'X-Served-By':   ['harper-cache-html'],
                'X-Bot-Kind':    [botKind || 'none'],
                'X-EW-Version':  ['2.2.0'],
            }, result.response.body);
        }
        return await originHtml(targetUrl, botKind, result.reason);
    }
    return await originHtml(targetUrl, botKind, null);
}

async function originHtml(targetUrl, botKind, fallbackReason) {
    const origin = await httpRequest(targetUrl, { method: 'GET' });
    const headers = { 'X-Served-By': ['origin-fallback'], 'X-Bot-Kind': [botKind || 'none'], 'X-EW-Version': ['2.2.0'] };
    for (const name of ORIGIN_PASSTHROUGH_HEADERS) {
        const v = origin.getHeader(name);
        if (v && v.length) headers[name] = v;
    }
    if (!headers['content-type']) headers['Content-Type'] = ['text/html; charset=utf-8'];
    if (fallbackReason) headers['X-Harper-Fallback-Reason'] = [sanitize(fallbackReason)];
    return createResponse(origin.status || 200, headers, origin.body);
}
