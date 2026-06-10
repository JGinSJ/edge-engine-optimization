import { httpRequest } from 'http-request';
import { createResponse } from 'create-response';
import { fetchFromHarper } from './harper-client.js';

export async function responseProvider(request) {
    try {
        // Harper configuration — read from Akamai property variables.
        // Set these in Control Center → Property Manager → Property Variables.
        // See .env.example for the full variable list and descriptions.
        const HARPER_ENABLED    = request.getVariable('PMUSER_HARPER_ENABLED') === 'true';
        const HARPER_URL        = request.getVariable('PMUSER_HARPER_URL')        ?? '';
        const HARPER_TOKEN      = request.getVariable('PMUSER_HARPER_TOKEN')      ?? '';
        const HARPER_TIMEOUT_MS = parseInt(request.getVariable('PMUSER_HARPER_TIMEOUT_MS') ?? '1500', 10);

        // getHeader() returns string[] in the EdgeWorkers API, not a plain string.
        const isVerifiedBot = (request.getHeader('x-verified-bot') ?? []).includes('true');
        const acceptHeader = request.getHeader('accept') ?? [];
        const acceptsMarkdown = acceptHeader.some(v => v.includes('text/markdown'));

        if (!isVerifiedBot && !acceptsMarkdown) {
            // Not bot traffic — property rule gates this EdgeWorker to
            // X-Verified-Bot:true requests, so this branch is a defensive guard only.
            return createResponse(200, {}, '');
        }

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

        // -----------------------------------------------------------------
        // Harper path — primary pre-rendered cache
        // -----------------------------------------------------------------
        if (HARPER_ENABLED) {
            const harperResult = await fetchFromHarper(targetUrl, {
                baseUrl:   HARPER_URL,
                token:     HARPER_TOKEN,
                timeoutMs: HARPER_TIMEOUT_MS,
            }, httpRequest);

            if (harperResult.ok) {
                // Pipe Harper's ReadableStream directly — no buffering, no size limit.
                return createResponse(200, {
                    'Content-Type':  ['text/markdown; charset=utf-8'],
                    'Cache-Control': ['max-age=3600, public'],
                    'X-Served-By':   ['harper-cache'],
                }, harperResult.response.body);
            }

            // Harper failed — fall through to Fermyon with reason tagged
            const fallbackReason = harperResult.reason;
            // Control characters must be stripped before use in response headers — network
            // errors can surface multi-line HTML pages in err.message, and the EdgeWorkers
            // API throws on any header value that contains \r, \n, or \t.
            const harperDetail   = String(harperResult.detail ?? '').replace(/[\r\n\t]/g, ' ').substring(0, 200);
            const harperBody     = String(harperResult.body   ?? '').replace(/[\r\n\t]/g, ' ').substring(0, 200);

            const wasmFunctionUrl = "https://bede2402-c4b7-4234-b17c-5e04fc46ef00.fwf.app";

            const wasmResponse = await httpRequest(wasmFunctionUrl, {
                method: 'GET',
                headers: { 'X-Target-URL': [targetUrl] }
            });

            if (wasmResponse.ok) {
                return createResponse(200, {
                    'Content-Type':              ['text/markdown; charset=utf-8'],
                    'X-Wasm-Execution':          ['success'],
                    'Cache-Control':             ['max-age=3600, public'],
                    'X-Served-By':               ['fermyon-fallback'],
                    'X-Harper-Fallback-Reason':  [fallbackReason],
                    'X-Harper-Debug-Detail':     [harperDetail],
                    'X-Harper-Debug-Body':       [harperBody],
                }, wasmResponse.body);
            } else {
                const err = await wasmResponse.text();
                return createResponse(500, { 'X-Wasm-Execution': ['failed'] }, `Wasm Error: ${err}`);
            }
        }

        // -----------------------------------------------------------------
        // Fermyon path — HARPER_ENABLED=false, behavior identical to pre-Harper
        // -----------------------------------------------------------------
        const wasmFunctionUrl = "https://bede2402-c4b7-4234-b17c-5e04fc46ef00.fwf.app";

        const wasmResponse = await httpRequest(wasmFunctionUrl, {
            method: 'GET',
            headers: { 'X-Target-URL': [targetUrl] }
        });

        if (wasmResponse.ok) {
            return createResponse(200, {
                'Content-Type':     ['text/markdown; charset=utf-8'],
                'X-Wasm-Execution': ['success'],
                'Cache-Control':    ['max-age=3600, public'],
            }, wasmResponse.body);
        } else {
            const err = await wasmResponse.text();
            return createResponse(500, { 'X-Wasm-Execution': ['failed'] }, `Wasm Error: ${err}`);
        }

    } catch (error) {
        return createResponse(500, {
            'X-Wasm-Execution': ['crashed'],
            'Cache-Control':    ['no-store'],
        }, `EdgeWorker Error: ${error.message}`);
    }
}
