// http-request is an Akamai EdgeWorker proprietary module — not available in Node.js.
// Both functions accept an injected _httpRequest for testing; in production the
// dynamic import resolves normally inside the Akamai runtime.
async function getRuntimeHttpRequest() {
    const mod = await import('http-request');
    return mod.httpRequest;
}


const TABLE = 'markdown_cache';

// Akamai's httpRequest normalises %2F → / in path segments, breaking URL keys.
// URL-safe base64 produces only [A-Za-z0-9\-_] so the path is never touched.
// btoa is not available in Akamai EdgeWorkers — manual encoder required.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function urlToKey(url) {
    let out = '';
    for (let i = 0; i < url.length; i += 3) {
        const a = url.charCodeAt(i), b = url.charCodeAt(i+1) || 0, c = url.charCodeAt(i+2) || 0;
        out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
        if (i + 1 < url.length) out += B64[((b & 15) << 2) | (c >> 6)];
        if (i + 2 < url.length) out += B64[c & 63];
    }
    return out;
}

/**
 * Read cached markdown from Harper.
 *
 * @param {string} targetUrl   - Full URL of the page the bot requested
 * @param {object} config
 * @param {string} config.baseUrl    - Harper REST API base URL (no trailing slash)
 * @param {string} config.token      - Bearer token
 * @param {number} config.timeoutMs  - Read timeout in milliseconds
 * @param {Function} [_httpRequest]  - Injected in tests; omit in production
 * @returns {Promise<
 *   | { ok: true,  markdown: string }
 *   | { ok: false, reason: 'cache-miss'|'timeout'|'http-error'|'network-error'|'no-markdown',
 *       detail?: string|number }
 * >}
 */
export async function readCache(targetUrl, { baseUrl, token, timeoutMs }, _httpRequest) {
    const httpRequest = _httpRequest ?? await getRuntimeHttpRequest();

    const url = baseUrl + '/' + TABLE + '/' + urlToKey(targetUrl);

    let response;
    try {
        response = await httpRequest(url, {
            method: 'GET',
            headers: { 'Authorization': ['Bearer ' + token] },
        });
    } catch (err) {
        const msg = (err && err.message) ? err.message.toLowerCase() : '';
        const reason = msg.includes('timeout') ? 'timeout' : 'network-error';
        return { ok: false, reason, detail: err ? err.message : 'unknown' };
    }

    if (response.status === 404) {
        return { ok: false, reason: 'cache-miss' };
    }

    if (response.status < 200 || response.status >= 300) {
        let errBody = '';
        try { errBody = (await response.text()).slice(0, 200); } catch (_) {}
        return { ok: false, reason: 'http-error', detail: response.status, body: errBody };
    }

    let record;
    try {
        const body = await response.text();
        record = JSON.parse(body);
    } catch (err) {
        return { ok: false, reason: 'no-markdown', detail: 'invalid-json' };
    }

    const markdown = record.markdown ?? '';
    if (!markdown) {
        return { ok: false, reason: 'no-markdown' };
    }

    return { ok: true, markdown };
}

/**
 * Write markdown to Harper cache.
 *
 * @param {string} targetUrl   - Full URL (becomes the cache key)
 * @param {string} markdown    - Markdown content to cache
 * @param {object} config
 * @param {string} config.baseUrl    - Harper REST API base URL (no trailing slash)
 * @param {string} config.token      - Bearer token
 * @param {number} config.timeoutMs  - Write timeout in milliseconds
 * @param {Function} [_httpRequest]  - Injected in tests; omit in production
 * @returns {Promise<
 *   | { ok: true }
 *   | { ok: false, reason: 'timeout'|'http-error'|'network-error',
 *       detail?: string|number }
 * >}
 */
export async function writeCache(targetUrl, markdown, { baseUrl, token, timeoutMs }, _httpRequest) {
    const httpRequest = _httpRequest ?? await getRuntimeHttpRequest();

    const key = urlToKey(targetUrl);
    const url = baseUrl + '/' + TABLE + '/' + key;

    const body = JSON.stringify({
        url: key,
        markdown,
        cached_at: new Date().toISOString(),
        content_type: 'text/markdown',
    });

    try {
        const response = await httpRequest(url, {
            method: 'PUT',
            headers: {
                'Authorization':  ['Bearer ' + token],
                'Content-Type':   ['application/json'],
                'Content-Length': [String(body.length)],
            },
            body,
        });

        if (response.status >= 200 && response.status < 300) {
            return { ok: true };
        }
        return { ok: false, reason: 'http-error', detail: response.status };
    } catch (err) {
        const msg = (err && err.message) ? err.message.toLowerCase() : '';
        const reason = msg.includes('timeout') ? 'timeout' : 'network-error';
        return { ok: false, reason, detail: err ? err.message : 'unknown' };
    }
}
