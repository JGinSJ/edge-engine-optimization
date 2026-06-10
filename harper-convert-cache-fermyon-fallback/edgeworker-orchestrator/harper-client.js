// http-request is an Akamai EdgeWorker proprietary module — not available in Node.js.
// fetchFromHarper accepts an injected _httpRequest for testing; in production the
// dynamic import resolves normally inside the Akamai runtime.
async function getRuntimeHttpRequest() {
    const mod = await import('http-request');
    return mod.httpRequest;
}

/**
 * @param {string} targetUrl - Full URL of the page the bot requested
 * @param {object} options
 * @param {string} options.baseUrl    - HARPER_URL (no trailing slash)
 * @param {string} options.token      - HARPER_TOKEN (used verbatim after "Bearer ")
 * @param {number} options.timeoutMs  - Milliseconds before treating as failure
 * @param {Function} [_httpRequest]   - Injected in tests; omit in production
 * @returns {Promise<
 *   | { ok: true,  response: object }
 *   | { ok: false, reason: 'timeout'|'http-error'|'wrong-content-type'
 *                          |'retry-after'|'network-error',
 *       detail?: string|number,
 *       body?: string }
 * >}
 * `body` is set only for `http-error` and contains the first 200 chars of Harper's response body.
 */
export async function fetchFromHarper(targetUrl, { baseUrl, token, timeoutMs }, _httpRequest) {
    const httpRequest = _httpRequest ?? await getRuntimeHttpRequest();

    // Separate path from query string — Harper wants them in different slots
    const qIdx = targetUrl.indexOf('?');
    const cleanPath = qIdx >= 0 ? targetUrl.slice(0, qIdx) : targetUrl;
    const qs       = qIdx >= 0 ? targetUrl.slice(qIdx)     : null;

    const harperUrl = baseUrl + '/page_content?path=' + encodeURIComponent(cleanPath);

    const headers = { 'Authorization': ['Bearer ' + token] };
    if (qs) headers['X-Query-String'] = [qs]; // Harper auto-prepends ? if missing

    let response;
    try {
        response = await httpRequest(harperUrl, {
            method: 'GET',
            headers,
            timeout: timeoutMs,
        });
    } catch (err) {
        const msg = (err && err.message) ? err.message.toLowerCase() : '';
        const reason = msg.includes('timeout') ? 'timeout' : 'network-error';
        return { ok: false, reason, detail: err ? err.message : 'unknown' };
    }

    if (response.status !== 200) {
        let body = '';
        try { body = await response.text(); } catch (_) {}
        return { ok: false, reason: 'http-error',
                 detail: response.status, body: body.slice(0, 200) };
    }

    if ((response.getHeader('retry-after') ?? []).length > 0) {
        return { ok: false, reason: 'retry-after',
                 detail: response.getHeader('retry-after')[0] };
    }

    const ct = (response.getHeader('content-type') ?? [])[0] ?? '';
    const hasMarkdownVersion = (response.getHeader('x-markdown-version') ?? []).length > 0;
    if (!ct.includes('text/markdown') && !hasMarkdownVersion) {
        return { ok: false, reason: 'wrong-content-type', detail: ct };
    }

    return { ok: true, response };
    // Caller streams response.body (ReadableStream) into createResponse()
    // — gzip passes through intact, no decompression step
}
