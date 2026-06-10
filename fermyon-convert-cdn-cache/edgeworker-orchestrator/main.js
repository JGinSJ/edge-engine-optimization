import { httpRequest } from 'http-request';
import { createResponse } from 'create-response';

export async function responseProvider(request) {
    try {
        // getHeader() returns string[] in the EdgeWorkers API, not a plain string.
        const isVerifiedBot = (request.getHeader('x-verified-bot') ?? []).includes('true');
        const acceptHeader = request.getHeader('accept') ?? [];
        const acceptsMarkdown = acceptHeader.some(v => v.includes('text/markdown'));

        if (!isVerifiedBot && !acceptsMarkdown) {
            // Property rule gates this EW to bot traffic — this branch is a defensive guard only.
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

        const wasmFunctionUrl = request.getVariable('PMUSER_WASM_URL') ?? '';

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
            return createResponse(500, {
                'X-Wasm-Execution': ['failed'],
                'Cache-Control':    ['no-store'],
            }, `Wasm Error: ${err}`);
        }

    } catch (error) {
        return createResponse(500, {
            'X-Wasm-Execution': ['crashed'],
            'Cache-Control':    ['no-store'],
        }, `EdgeWorker Error: ${error.message}`);
    }
}