// http-request is an Akamai EdgeWorker proprietary module — not available in Node.js.
// The fetch helpers accept an injected _httpRequest for testing; in production the
// dynamic import resolves normally inside the Akamai runtime.
async function getRuntimeHttpRequest() {
    const mod = await import('http-request');
    return mod.httpRequest;
}

// Default header carrying the shared bot-routing secret the Harper component
// gates /page and /page_content on (upstream constant: BOT_REQUEST_KEY_NAME).
const DEFAULT_KEY_HEADER = 'x-pr-req-key';

/**
 * Shared request core for both Harper delivery endpoints.
 *
 * Applies the same failure taxonomy used across the pipeline:
 * timeout | http-error | retry-after | wrong-content-type | network-error.
 *
 * @param {string} harperUrl              - Fully-built Harper delivery URL
 * @param {object} headers                - Request headers (EdgeWorker array-value shape)
 * @param {number} timeoutMs              - Per-request timeout
 * @param {(ct: string, response: object) => boolean} acceptsContentType
 * @param {Function} httpRequest
 * @returns {Promise<{ok:true,response:object}|{ok:false,reason:string,detail?:any,body?:string}>}
 */
async function requestHarper(harperUrl, headers, timeoutMs, acceptsContentType, httpRequest) {
    let response;
    try {
        response = await httpRequest(harperUrl, { method: 'GET', headers, timeout: timeoutMs });
    } catch (err) {
        const msg = (err && err.message) ? err.message.toLowerCase() : '';
        const reason = msg.includes('timeout') ? 'timeout' : 'network-error';
        return { ok: false, reason, detail: err ? err.message : 'unknown' };
    }

    if (response.status !== 200) {
        let body = '';
        try { body = await response.text(); } catch (_) {}
        return { ok: false, reason: 'http-error', detail: response.status, body: body.slice(0, 200) };
    }

    if ((response.getHeader('retry-after') ?? []).length > 0) {
        return { ok: false, reason: 'retry-after', detail: response.getHeader('retry-after')[0] };
    }

    const ct = (response.getHeader('content-type') ?? [])[0] ?? '';
    if (!acceptsContentType(ct, response)) {
        return { ok: false, reason: 'wrong-content-type', detail: ct };
    }

    return { ok: true, response };
    // Caller streams response.body (ReadableStream) into createResponse()
    // — gzip passes through intact, no decompression step.
}

/**
 * Build the auth/secret headers shared by both endpoints.
 * Sends the bot-key header the component validates, and keeps the legacy
 * `Authorization: Bearer` header for compatibility with the baseline contract.
 */
function authHeaders({ token, botKey, keyHeader = DEFAULT_KEY_HEADER }) {
    const headers = { 'Authorization': ['Bearer ' + token] };
    const keyValue = botKey ?? token;
    if (keyHeader && keyValue != null) headers[keyHeader] = [String(keyValue)];
    return headers;
}

/**
 * Fetch pre-rendered **Markdown** for AI crawlers from Harper's /page_content.
 *
 * @param {string} targetUrl - Full URL of the page the bot requested
 * @param {object} options
 * @param {string} options.baseUrl    - HARPER_URL (no trailing slash)
 * @param {string} options.token      - HARPER_TOKEN (used verbatim after "Bearer ")
 * @param {number} options.timeoutMs  - Milliseconds before treating as failure
 * @param {string} [options.botKey]   - Value for the bot-key header (defaults to token)
 * @param {string} [options.keyHeader]- Bot-key header name (default x-pr-req-key)
 * @param {Function} [_httpRequest]   - Injected in tests; omit in production
 * @returns {Promise<
 *   | { ok: true,  response: object }
 *   | { ok: false, reason: 'timeout'|'http-error'|'wrong-content-type'
 *                          |'retry-after'|'network-error',
 *       detail?: string|number, body?: string }
 * >}
 * `body` is set only for `http-error` and contains the first 200 chars of Harper's response body.
 */
export async function fetchFromHarper(targetUrl, { baseUrl, token, timeoutMs, botKey, keyHeader }, _httpRequest) {
    const httpRequest = _httpRequest ?? await getRuntimeHttpRequest();

    // Separate path from query string — Harper wants them in different slots
    const qIdx = targetUrl.indexOf('?');
    const cleanPath = qIdx >= 0 ? targetUrl.slice(0, qIdx) : targetUrl;
    const qs        = qIdx >= 0 ? targetUrl.slice(qIdx)     : null;

    const harperUrl = baseUrl + '/page_content?path=' + encodeURIComponent(cleanPath);

    const headers = authHeaders({ token, botKey, keyHeader });
    if (qs) headers['X-Query-String'] = [qs]; // Harper auto-prepends ? if missing

    // Accept text/markdown, or a payload tagged with x-markdown-version (gzip blobs
    // that may surface as application/octet-stream).
    const acceptsMarkdown = (ct, response) =>
        ct.includes('text/markdown') || (response.getHeader('x-markdown-version') ?? []).length > 0;

    return requestHarper(harperUrl, headers, timeoutMs, acceptsMarkdown, httpRequest);
}

/**
 * Fetch pre-rendered **HTML** for humans / SEO crawlers from Harper's /page.
 *
 * Mirrors {@link fetchFromHarper} but targets the HTML delivery endpoint and
 * accepts `text/html`. The component keys its cache by device type, so the
 * caller may pass `deviceType` (defaults to desktop).
 *
 * @param {string} targetUrl
 * @param {object} options - same as fetchFromHarper, plus:
 * @param {string} [options.deviceType] - desktop | mobile | tablet (default desktop)
 * @param {Function} [_httpRequest]
 * @returns {Promise<{ok:true,response:object}|{ok:false,reason:string,detail?:any,body?:string}>}
 */
export async function fetchHtmlFromHarper(
    targetUrl,
    { baseUrl, token, timeoutMs, botKey, keyHeader, deviceType = 'desktop' },
    _httpRequest
) {
    const httpRequest = _httpRequest ?? await getRuntimeHttpRequest();

    const harperUrl =
        baseUrl + '/page/?url=' + encodeURIComponent(targetUrl) + '&deviceType=' + encodeURIComponent(deviceType);

    const headers = authHeaders({ token, botKey, keyHeader });

    const acceptsHtml = (ct) => ct.includes('text/html');

    return requestHarper(harperUrl, headers, timeoutMs, acceptsHtml, httpRequest);
}
