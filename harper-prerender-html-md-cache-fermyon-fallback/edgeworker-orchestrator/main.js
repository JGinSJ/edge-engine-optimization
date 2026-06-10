import { httpRequest } from 'http-request';
import { createResponse } from 'create-response';
import { fetchFromHarper, fetchHtmlFromHarper } from './harper-client.js';
import { parseCrawlerPolicy, detectBotKind, resolveRepresentation } from './crawler-policy.js';

// Fermyon Spin Wasm function — on-demand HTML→Markdown fallback for the AI path.
// Overridable at runtime via the PMUSER_WASM_URL property variable; this is the
// default POC endpoint.
const DEFAULT_WASM_FUNCTION_URL = 'https://bede2402-c4b7-4234-b17c-5e04fc46ef00.fwf.app';

// AI crawlers that should be served Markdown. User-Agents are spoofable, but in
// production this is paired with Akamai Bot Manager's verified X-Verified-Bot
// signal. Override via the PMUSER_AI_CRAWLER_UAS property variable (comma-separated).
const DEFAULT_AI_CRAWLER_UAS = [
    'gptbot', 'oai-searchbot', 'chatgpt-user', 'claudebot', 'claude-web',
    'anthropic-ai', 'perplexitybot', 'google-extended', 'bytespider', 'ccbot', 'cohere-ai',
];

// Origin response headers worth forwarding when we proxy origin HTML directly.
const ORIGIN_PASSTHROUGH_HEADERS = ['content-type', 'content-encoding', 'cache-control', 'last-modified', 'etag', 'vary'];

// Header values cannot contain \r \n \t (EdgeWorkers throws); trim noisy detail too.
function sanitize(v) {
    return String(v ?? '').replace(/[\r\n\t]/g, ' ').substring(0, 200);
}

export async function responseProvider(request) {
    try {
        // Harper configuration — read from Akamai property variables.
        // See .env.example for the full variable list and descriptions.
        const HARPER_ENABLED    = request.getVariable('PMUSER_HARPER_ENABLED') === 'true';
        const HARPER_URL        = request.getVariable('PMUSER_HARPER_URL')   ?? '';
        const HARPER_TOKEN      = request.getVariable('PMUSER_HARPER_TOKEN') ?? '';
        const HARPER_BOT_KEY    = request.getVariable('PMUSER_HARPER_BOT_KEY') ?? '';
        const HARPER_TIMEOUT_MS = parseInt(request.getVariable('PMUSER_HARPER_TIMEOUT_MS') ?? '1500', 10);
        const WASM_URL          = request.getVariable('PMUSER_WASM_URL') || DEFAULT_WASM_FUNCTION_URL;

        const aiUasRaw = request.getVariable('PMUSER_AI_CRAWLER_UAS') ?? '';
        const aiCrawlerUas = aiUasRaw
            ? aiUasRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
            : DEFAULT_AI_CRAWLER_UAS;

        // Per-crawler content policy (built-in defaults ∪ PMUSER_CRAWLER_POLICY override).
        const crawlerPolicy = parseCrawlerPolicy(request.getVariable('PMUSER_CRAWLER_POLICY') ?? '');

        // -----------------------------------------------------------------
        // Per-crawler content negotiation
        //   Identify the crawler (X-Bot-Kind header in the demo; Bot Manager's
        //   verified signal + UA in production), then resolve HTML vs Markdown
        //   from the policy. Both representations come from the SAME cached render.
        // -----------------------------------------------------------------
        const acceptHeader    = request.getHeader('accept') ?? [];
        const acceptsMarkdown = acceptHeader.some((v) => v.includes('text/markdown'));
        const userAgent       = ((request.getHeader('user-agent') ?? [])[0] ?? '').toLowerCase();
        const botKindHeader   = (request.getHeader('x-bot-kind') ?? [])[0];
        const isAiUa          = aiCrawlerUas.some((token) => userAgent.includes(token));
        const botKind         = detectBotKind(botKindHeader, userAgent);
        const representation  = resolveRepresentation({ botKind, acceptsMarkdown, isAiUa, policy: crawlerPolicy });

        // Target URL: prefer ?url= query param (demo UI mode), fall back to the
        // actual request URL (production property mode — no redeployment needed).
        let targetUrl = null;
        if (request.query) {
            const queryMatch = request.query.match(/url=([^&]+)/);
            if (queryMatch) targetUrl = decodeURIComponent(queryMatch[1]);
        }
        if (!targetUrl) {
            const host = (request.getHeader('host') ?? [])[0] ?? request.host;
            targetUrl = 'https://' + host + request.path;
        }
        if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;

        const harperOpts = {
            baseUrl:   HARPER_URL,
            token:     HARPER_TOKEN,
            botKey:    HARPER_BOT_KEY || undefined,
            timeoutMs: HARPER_TIMEOUT_MS,
        };

        return representation === 'markdown'
            ? await serveMarkdown(targetUrl, HARPER_ENABLED, harperOpts, WASM_URL, botKind)
            : await serveHtml(targetUrl, HARPER_ENABLED, harperOpts, botKind);
    } catch (error) {
        return createResponse(500, {
            'X-Wasm-Execution': ['crashed'],
            'Cache-Control':    ['no-store'],
        }, `EdgeWorker Error: ${error.message}`);
    }
}

// ---------------------------------------------------------------------------
// AI crawler path — Markdown from Harper, Fermyon fallback
// ---------------------------------------------------------------------------
async function serveMarkdown(targetUrl, harperEnabled, harperOpts, wasmUrl, botKind) {
    if (harperEnabled) {
        const result = await fetchFromHarper(targetUrl, harperOpts, httpRequest);
        if (result.ok) {
            // Stream Harper's gzip Markdown directly — no buffering, no size limit.
            return createResponse(200, {
                'Content-Type':  ['text/markdown; charset=utf-8'],
                'Cache-Control': ['max-age=3600, public'],
                'X-Served-By':   ['harper-cache-md'],
                'X-Bot-Kind':    [botKind || 'none'],
            }, result.response.body);
        }
        return fermyonMarkdown(targetUrl, {
            reason: result.reason,
            detail: sanitize(result.detail),
            body:   sanitize(result.body),
        }, wasmUrl, botKind);
    }
    return fermyonMarkdown(targetUrl, null, wasmUrl, botKind);
}

async function fermyonMarkdown(targetUrl, fallback, wasmUrl, botKind) {
    const wasmResponse = await httpRequest(wasmUrl, {
        method: 'GET',
        headers: { 'X-Target-URL': [targetUrl] },
    });

    if (wasmResponse.ok) {
        const headers = {
            'Content-Type':     ['text/markdown; charset=utf-8'],
            'X-Wasm-Execution': ['success'],
            'Cache-Control':    ['max-age=3600, public'],
            'X-Served-By':      ['fermyon-fallback'],
            'X-Bot-Kind':       [botKind || 'none'],
        };
        if (fallback) {
            headers['X-Harper-Fallback-Reason'] = [fallback.reason];
            headers['X-Harper-Debug-Detail']    = [fallback.detail];
            headers['X-Harper-Debug-Body']      = [fallback.body];
        }
        return createResponse(200, headers, wasmResponse.body);
    }

    const err = await wasmResponse.text();
    return createResponse(500, { 'X-Wasm-Execution': ['failed'] }, `Wasm Error: ${err}`);
}

// ---------------------------------------------------------------------------
// Human / SEO path — prerendered HTML from Harper, origin fallback
// ---------------------------------------------------------------------------
async function serveHtml(targetUrl, harperEnabled, harperOpts, botKind) {
    if (harperEnabled) {
        const result = await fetchHtmlFromHarper(targetUrl, harperOpts, httpRequest);
        if (result.ok) {
            return createResponse(200, {
                'Content-Type':  ['text/html; charset=utf-8'],
                'Cache-Control': ['max-age=3600, public'],
                'X-Served-By':   ['harper-cache-html'],
                'X-Bot-Kind':    [botKind || 'none'],
            }, result.response.body);
        }
        return originHtml(targetUrl, { reason: result.reason, detail: sanitize(result.detail) }, botKind);
    }
    return originHtml(targetUrl, null, botKind);
}

async function originHtml(targetUrl, fallback, botKind) {
    const originResponse = await httpRequest(targetUrl, { method: 'GET' });

    const headers = { 'X-Served-By': ['origin-fallback'], 'X-Bot-Kind': [botKind || 'none'] };
    for (const name of ORIGIN_PASSTHROUGH_HEADERS) {
        const value = originResponse.getHeader(name);
        if (value && value.length) headers[name] = value;
    }
    if (!headers['content-type']) headers['Content-Type'] = ['text/html; charset=utf-8'];
    if (fallback) {
        headers['X-Harper-Fallback-Reason'] = [fallback.reason];
        headers['X-Harper-Debug-Detail']    = [fallback.detail];
    }

    return createResponse(originResponse.status || 200, headers, originResponse.body);
}
