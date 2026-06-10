import { httpRequest } from 'http-request';
import { createResponse } from 'create-response';
import { TextEncoder } from 'encoding';
import { TransformStream } from 'streams';
import { readCache, urlToKey } from './harper-cache-client.js';

// Static imports make TextEncoder and TransformStream available synchronously.
// new ReadableStream({start}) is not constructible in EdgeWorkers; TransformStream is.
function stringToStream(str) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    writer.write(new TextEncoder().encode(str));
    writer.close();
    return readable;
}

// Resolve a property-variable URL/path, falling back when it's missing, empty,
// or malformed. Accepts either an absolute http(s) URL or an on-property
// relative path (e.g. /_fermyon, proxied to the converter — the EW can only
// reach Akamai-fronted hosts, so the off-Akamai converter is fronted by a
// property proxy rule, same as /_harper). A bare `|| default` wouldn't catch a
// stray space / quotes / typo (truthy), which httpRequest() rejects as "[no URL]".
function resolveHttpUrl(raw, fallback) {
    const v = (raw ?? '').trim();
    return (/^https?:\/\//i.test(v) || v.startsWith('/')) ? v : fallback;
}

export async function responseProvider(request) {
    try {
        const HARPER_ENABLED          = request.getVariable('PMUSER_HARPER_ENABLED') !== 'false';
        // Reads go through the on-property Harper proxy (relative path, e.g. /_harper).
        const HARPER_URL              = request.getVariable('PMUSER_HARPER_URL')              ?? '';
        // Writes are done by Fermyon (off-property), so they need the ABSOLUTE Harper
        // URL — the relative proxy path is unreachable from Fermyon. Forwarded to the
        // converter as X-Harper-Url. Scheme-validated fallback (the Harper host is
        // not secret — only PMUSER_HARPER_TOKEN is, and that keeps no code default).
        const HARPER_WRITE_URL        = resolveHttpUrl(request.getVariable('PMUSER_HARPER_WRITE_URL'),
            'https://ai-seo-pipeline.jgeronim-org.harperfabric.com');
        const HARPER_TOKEN            = request.getVariable('PMUSER_HARPER_TOKEN')            ?? '';
        const HARPER_TIMEOUT_MS       = parseInt(request.getVariable('PMUSER_HARPER_TIMEOUT_MS')       ?? '1500', 10);
        // Scheme-validated so a missing/empty/garbage PMUSER_WASM_URL falls back to
        // this project's write-back-enabled converter instead of triggering a
        // "[no URL]" error from httpRequest().
        // Default MUST be an Akamai-fronted (.fwf.app, deployed via `spin aka`) host —
        // the EW can't reach Fermyon Cloud (.fermyon.app / AWS), which returns "[no URL]".
        const WASM_URL                = resolveHttpUrl(request.getVariable('PMUSER_WASM_URL'),
            'https://977adc68-2ede-4bf3-9b1e-41923fa6d7a9.fwf.app');

        const isVerifiedBot = (request.getHeader('x-verified-bot') ?? []).includes('true');
        const acceptHeader = request.getHeader('accept') ?? [];
        const acceptsMarkdown = acceptHeader.some(v => v.includes('text/markdown'));

        if (!isVerifiedBot && !acceptsMarkdown) {
            return createResponse(200, {}, '');
        }

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

        // -----------------------------------------------------------------
        // Fermyon-only path — Harper disabled or unconfigured
        // -----------------------------------------------------------------
        if (!HARPER_ENABLED || !HARPER_URL) {
            const wasmResponse = await httpRequest(WASM_URL, {
                method: 'GET',
                headers: { 'X-Target-URL': [targetUrl] },
            });

            if (wasmResponse.ok) {
                return createResponse(200, {
                    'Content-Type':     ['text/markdown; charset=utf-8'],
                    'X-Wasm-Execution': ['success'],
                    'Cache-Control':    ['max-age=3600, public'],
                    'X-Served-By':      ['fermyon-origin'],
                }, wasmResponse.body);
            }
            const err = await wasmResponse.text();
            return createResponse(500, {
                'X-Wasm-Execution': ['failed'],
                'Cache-Control':    ['no-store'],
            }, `Wasm Error: ${err}`);
        }

        // -----------------------------------------------------------------
        // Harper cache read
        // -----------------------------------------------------------------
        const cacheResult = await readCache(targetUrl, {
            baseUrl:   HARPER_URL,
            token:     HARPER_TOKEN,
            timeoutMs: HARPER_TIMEOUT_MS,
        }, httpRequest);

        if (cacheResult.ok) {
            return createResponse(200, {
                'Content-Type':  ['text/markdown; charset=utf-8'],
                'Cache-Control': ['max-age=3600, public'],
                'X-Served-By':   ['harper-cache'],
            }, stringToStream(cacheResult.markdown));
        }

        const harperReadReason = cacheResult.reason;

        // -----------------------------------------------------------------
        // Cache miss — Fermyon conversion + Harper write-through.
        //
        // The EdgeWorker can't PUT to Harper from the edge (platform limits:
        // PUT body → 501, Ops API :9925 unreachable). So it forwards the Harper
        // target + bearer token + the precomputed cache key, and Fermyon — which
        // already fetched and converted — performs the write-through itself.
        // The EW is read-only against Harper; Fermyon reports the write outcome
        // back in X-Harper-Write, which we surface as X-Cache-Write.
        // -----------------------------------------------------------------
        const wasmResponse = await httpRequest(WASM_URL, {
            method: 'GET',
            headers: {
                'X-Target-URL':       [targetUrl],
                'X-Harper-Url':       [HARPER_WRITE_URL],
                'X-Harper-Token':     [HARPER_TOKEN],
                'X-Harper-Key':       [urlToKey(targetUrl)],
                'X-Harper-Cached-At': [new Date().toISOString()],
            },
        });

        if (!wasmResponse.ok) {
            const err = await wasmResponse.text();
            return createResponse(500, {
                'X-Wasm-Execution':     ['failed'],
                'Cache-Control':        ['no-store'],
                'X-Harper-Read-Reason': [harperReadReason],
                // Diagnostics: confirm which bundle is live and what it resolved
                // WASM_URL to (reveals a set-but-invalid PMUSER_WASM_URL).
                'X-EW-Version':         ['1.2.4'],
                'X-Wasm-Url-Used':      [WASM_URL.replace(/[\r\n\t]/g, ' ').substring(0, 160)],
            }, `Wasm Error: ${err}`);
        }

        const markdown = await wasmResponse.text();
        const cacheWriteStatus = (wasmResponse.getHeader('X-Harper-Write') ?? ['unknown'])[0] ?? 'unknown';

        return createResponse(200, {
            'Content-Type':          ['text/markdown; charset=utf-8'],
            'X-Wasm-Execution':      ['success'],
            'Cache-Control':         ['max-age=3600, public'],
            'X-Served-By':           ['fermyon-origin'],
            'X-Cache-Write':         [cacheWriteStatus],
            'X-Harper-Read-Reason':  [harperReadReason],
            'X-EW-Version':          ['1.2.4'],
        }, stringToStream(markdown));

    } catch (error) {
        return createResponse(500, {
            'X-Wasm-Execution': ['crashed'],
            'Cache-Control':    ['no-store'],
        }, `EdgeWorker Error: ${error.message}`);
    }
}
