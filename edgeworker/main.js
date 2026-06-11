import { httpRequest } from 'http-request';
import { createResponse } from 'create-response';
import { TextEncoder } from 'encoding';
import { TransformStream } from 'streams';
import { readMarkdown, urlToKey } from './harper-read.js';

// Unified read-only EdgeWorker (Phase B). One bundle, four scenarios by PMUSER_* config:
//   cdn-cache      HARPER_ENABLED=false → Fermyon convert → Markdown (Akamai CDN caches it)
//   md-cache       HARPER_READ_MODE=markdown_cache, WRITE_THROUGH=true  (Fermyon writes Harper on miss)
//   convert-cache  HARPER_READ_MODE=page_content,   WRITE_THROUGH=false (Harper self-populates; Fermyon=fallback)
//   prerender      + SERVE_HTML=true + CRAWLER_POLICY            (HTML+MD per-crawler — NEXT INCREMENT)
// The EW never writes Harper itself; the Function does the write-through (X-Harper-* headers).

// new ReadableStream({start}) is not constructible in EdgeWorkers; TransformStream is.
function stringToStream(str) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    writer.write(new TextEncoder().encode(str));
    writer.close();
    return readable;
}

// Resolve a property-variable URL/path; fall back when missing, empty, or non-http(s).
function resolveHttpUrl(raw, fallback) {
    const v = (raw ?? '').trim();
    return (/^https?:\/\//i.test(v) || v.startsWith('/')) ? v : fallback;
}

export async function responseProvider(request) {
    try {
        const HARPER_ENABLED    = request.getVariable('PMUSER_HARPER_ENABLED') !== 'false';
        // Read base (on-property proxy, e.g. /_harper) and which read contract to speak.
        const HARPER_URL        = request.getVariable('PMUSER_HARPER_URL') ?? '';
        const HARPER_READ_MODE  = (request.getVariable('PMUSER_HARPER_READ_MODE') || 'markdown_cache').trim();
        // Write-through: only md-cache populates Harper via the Function on a miss.
        const WRITE_THROUGH     = request.getVariable('PMUSER_WRITE_THROUGH') === 'true';
        // SERVE_HTML + CRAWLER_POLICY drive the prerender (HTML/per-crawler) path — next increment.
        const SERVE_HTML        = request.getVariable('PMUSER_SERVE_HTML') === 'true';
        // Absolute write target — MUST be the same Harper node /_harper reads from (gq4 node;
        // the Fabric cluster doesn't replicate). Forwarded to the Function, which does the PUT.
        const HARPER_WRITE_URL  = resolveHttpUrl(request.getVariable('PMUSER_HARPER_WRITE_URL'),
            'https://gq4-us-east5-a-1.ai-seo-pipeline.jgeronim-org.harperfabric.com');
        const HARPER_TOKEN      = request.getVariable('PMUSER_HARPER_TOKEN') ?? '';
        const HARPER_TIMEOUT_MS = parseInt(request.getVariable('PMUSER_HARPER_TIMEOUT_MS') ?? '1500', 10);
        // Fermyon converter — MUST be Akamai-fronted (.fwf.app via `spin aka`), not Fermyon Cloud.
        const WASM_URL          = resolveHttpUrl(request.getVariable('PMUSER_WASM_URL'),
            'https://977adc68-2ede-4bf3-9b1e-41923fa6d7a9.fwf.app');

        const isVerifiedBot   = (request.getHeader('x-verified-bot') ?? []).includes('true');
        const acceptHeader    = request.getHeader('accept') ?? [];
        const acceptsMarkdown = acceptHeader.some(v => v.includes('text/markdown'));

        // Humans: HTML/SERVE_HTML path is the next increment; for now pass non-bot traffic through.
        if (!isVerifiedBot && !acceptsMarkdown) {
            return createResponse(200, {}, '');
        }

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

        const MD_HEADERS = {
            'Content-Type':  ['text/markdown; charset=utf-8'],
            'Cache-Control': ['max-age=3600, public'],
        };

        // ── cdn-cache: no Harper — convert at the edge, let Akamai CDN cache it ──────
        if (!HARPER_ENABLED || !HARPER_URL) {
            const wasm = await httpRequest(WASM_URL, { method: 'GET', headers: { 'X-Target-URL': [targetUrl] } });
            if (wasm.ok) {
                return createResponse(200, { ...MD_HEADERS, 'X-Wasm-Execution': ['success'], 'X-Served-By': ['fermyon-origin'] }, wasm.body);
            }
            const err = await wasm.text();
            return createResponse(500, { 'X-Wasm-Execution': ['failed'], 'Cache-Control': ['no-store'] }, `Wasm Error: ${err}`);
        }

        // ── Harper read (markdown_cache | page_content) ─────────────────────────────
        const read = await readMarkdown(HARPER_READ_MODE, targetUrl, {
            baseUrl: HARPER_URL, token: HARPER_TOKEN, timeoutMs: HARPER_TIMEOUT_MS,
        }, httpRequest);

        if (read.ok) {
            return createResponse(200, { ...MD_HEADERS, 'X-Served-By': ['harper-cache-md'] }, stringToStream(read.markdown));
        }
        const harperReadReason = read.reason;

        // ── Miss → Fermyon convert (+ write-through population when enabled) ─────────
        const wasmHeaders = { 'X-Target-URL': [targetUrl] };
        if (WRITE_THROUGH) {
            wasmHeaders['X-Harper-Url']       = [HARPER_WRITE_URL];
            wasmHeaders['X-Harper-Token']     = [HARPER_TOKEN];
            wasmHeaders['X-Harper-Key']       = [urlToKey(targetUrl)];
            wasmHeaders['X-Harper-Cached-At'] = [new Date().toISOString()];
        }
        const wasm = await httpRequest(WASM_URL, { method: 'GET', headers: wasmHeaders });

        if (!wasm.ok) {
            const err = await wasm.text();
            return createResponse(500, {
                'X-Wasm-Execution':     ['failed'],
                'Cache-Control':        ['no-store'],
                'X-Harper-Read-Reason': [harperReadReason],
                'X-EW-Version':         ['2.0.0'],
            }, `Wasm Error: ${err}`);
        }

        const markdown = await wasm.text();
        // Fermyon is the SOURCE for write-through/cdn; only a FALLBACK for Harper-backend scenarios.
        const servedBy = WRITE_THROUGH ? 'fermyon-origin' : 'fermyon-fallback';
        const cacheWrite = WRITE_THROUGH ? ((wasm.getHeader('X-Harper-Write') ?? ['unknown'])[0] ?? 'unknown') : 'skip';

        return createResponse(200, {
            ...MD_HEADERS,
            'X-Wasm-Execution':     ['success'],
            'X-Served-By':          [servedBy],
            'X-Cache-Write':        [cacheWrite],
            'X-Harper-Read-Reason': [harperReadReason],
            'X-EW-Version':         ['2.0.0'],
        }, stringToStream(markdown));

    } catch (error) {
        return createResponse(500, { 'X-Wasm-Execution': ['crashed'], 'Cache-Control': ['no-store'] }, `EdgeWorker Error: ${error.message}`);
    }
}
