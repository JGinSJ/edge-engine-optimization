// Unified Harper read for the consolidated (Phase B) EdgeWorker.
//
// Two read modes, selected by PMUSER_HARPER_READ_MODE:
//   markdown_cache → GET {base}/markdown_cache/<urlToKey(url)>   (JSON record { markdown, … };
//                    the md-cache write-through store)
//   page_content   → GET {base}/page_content?path=<url>           (markdown returned as the body;
//                    the Harper-self-populating backends: convert-cache, prerender)
//
// Both normalize to:
//   { ok: true,  markdown: string }
//   { ok: false, reason: 'cache-miss'|'timeout'|'http-error'|'network-error'|'no-markdown',
//                detail?: string|number, body?: string }
//
// http-request is an Akamai EdgeWorker proprietary module — unavailable in Node.js,
// so it's injectable for tests; production resolves it dynamically.
async function getRuntimeHttpRequest() {
    const mod = await import('http-request');
    return mod.httpRequest;
}

// URL-safe base64 (btoa is unavailable in EdgeWorkers; %2F in a path segment would be
// normalised by Akamai's httpRequest). Alphabet is [A-Za-z0-9-_], no padding.
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function urlToKey(url) {
    let out = '';
    for (let i = 0; i < url.length; i += 3) {
        const a = url.charCodeAt(i), b = url.charCodeAt(i + 1) || 0, c = url.charCodeAt(i + 2) || 0;
        out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
        if (i + 1 < url.length) out += B64[((b & 15) << 2) | (c >> 6)];
        if (i + 2 < url.length) out += B64[c & 63];
    }
    return out;
}

// Standard base64 (with +/ and = padding) for HTTP Basic credentials — distinct from
// the URL-safe urlToKey above. btoa/TextEncoder aren't guaranteed in EdgeWorkers, so
// we derive UTF-8 bytes via encodeURIComponent (core JS, available everywhere).
const STD_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function utf8Bytes(str) {
    const enc = encodeURIComponent(str);
    const bytes = [];
    for (let i = 0; i < enc.length; i++) {
        if (enc[i] === '%') { bytes.push(parseInt(enc.substr(i + 1, 2), 16)); i += 2; }
        else bytes.push(enc.charCodeAt(i));
    }
    return bytes;
}
function base64Std(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i], b = i + 1 < bytes.length ? bytes[i + 1] : 0, c = i + 2 < bytes.length ? bytes[i + 2] : 0;
        out += STD_B64[a >> 2] + STD_B64[((a & 3) << 4) | (b >> 4)];
        out += i + 1 < bytes.length ? STD_B64[((b & 15) << 2) | (c >> 6)] : '=';
        out += i + 2 < bytes.length ? STD_B64[c & 63] : '=';
    }
    return out;
}

// Build the Harper Authorization header. The Harper Fabric data API authenticates
// with HTTP Basic (username/password) — Bearer is rejected with 401 "Must login" —
// so prefer Basic when a username is configured. Falls back to Bearer + token for
// any caller/endpoint still using token auth.
export function harperAuthHeader({ user, pass, token } = {}) {
    if (user) return 'Basic ' + base64Std(utf8Bytes((user || '') + ':' + (pass || '')));
    return 'Bearer ' + (token || '');
}

export async function readMarkdown(mode, targetUrl, { baseUrl, authHeader, token, timeoutMs }, _httpRequest) {
    const httpRequest = _httpRequest ?? await getRuntimeHttpRequest();
    const auth = { 'Authorization': [authHeader || ('Bearer ' + token)] };

    let url, headers = auth, parseJson;
    if (mode === 'page_content') {
        // Harper wants path and query string in separate slots.
        const qIdx = targetUrl.indexOf('?');
        const cleanPath = qIdx >= 0 ? targetUrl.slice(0, qIdx) : targetUrl;
        const qs        = qIdx >= 0 ? targetUrl.slice(qIdx)     : null;
        url = baseUrl + '/page_content?path=' + encodeURIComponent(cleanPath);
        headers = qs ? { ...auth, 'X-Query-String': [qs] } : auth;
        parseJson = false;
    } else { // markdown_cache (default)
        url = baseUrl + '/markdown_cache/' + urlToKey(targetUrl);
        parseJson = true;
    }

    let response;
    try {
        response = await httpRequest(url, { method: 'GET', headers });
    } catch (err) {
        const msg = (err && err.message) ? err.message.toLowerCase() : '';
        return { ok: false, reason: msg.includes('timeout') ? 'timeout' : 'network-error',
                 detail: err ? err.message : 'unknown' };
    }

    if (response.status === 404) return { ok: false, reason: 'cache-miss' };
    if (response.status < 200 || response.status >= 300) {
        let body = '';
        try { body = (await response.text()).slice(0, 200); } catch (_) {}
        return { ok: false, reason: 'http-error', detail: response.status, body };
    }

    let markdown;
    try {
        const text = await response.text();
        markdown = parseJson ? (JSON.parse(text).markdown ?? '') : text;
    } catch (_) {
        return { ok: false, reason: 'no-markdown', detail: 'invalid-body' };
    }
    if (!markdown) return { ok: false, reason: 'no-markdown' };
    return { ok: true, markdown };
}
