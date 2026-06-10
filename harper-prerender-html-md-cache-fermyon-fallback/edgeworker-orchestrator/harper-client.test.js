import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchFromHarper, fetchHtmlFromHarper } from './harper-client.js';

// ---------------------------------------------------------------------------
// Helpers — build mock httpRequest responses matching Akamai's response shape
// ---------------------------------------------------------------------------

function makeResponse({ status = 200, headers = {}, body = null } = {}) {
    const normalised = {};
    for (const [k, v] of Object.entries(headers)) {
        normalised[k.toLowerCase()] = Array.isArray(v) ? v : [v];
    }
    return {
        status,
        ok: status >= 200 && status < 300,
        getHeader(name) { return normalised[name.toLowerCase()] ?? null; },
        body,
    };
}

function mockHttpRequest(response) {
    return async (_url, _opts) => response;
}

function mockHttpRequestThrowing(message) {
    return async (_url, _opts) => { throw new Error(message); };
}

const BASE_OPTS = { baseUrl: 'https://harper.example.com', token: 'tok', timeoutMs: 1500 };
const TARGET    = 'https://example.com/page';
const TARGET_QS = 'https://example.com/page?foo=bar';

// ---------------------------------------------------------------------------
// Success cases
// ---------------------------------------------------------------------------

test('200 with text/markdown returns ok:true with response object', async () => {
    const resp = makeResponse({
        status: 200,
        headers: { 'content-type': 'text/markdown; charset=utf-8', 'content-encoding': 'gzip' },
    });
    const result = await fetchFromHarper(TARGET, BASE_OPTS, mockHttpRequest(resp));
    assert.equal(result.ok, true);
    assert.equal(result.response, resp);
});

// ---------------------------------------------------------------------------
// http-error (5xx)
// ---------------------------------------------------------------------------

test('503 response returns http-error with status as detail', async () => {
    const resp = makeResponse({ status: 503, headers: { 'content-type': 'text/markdown' } });
    const result = await fetchFromHarper(TARGET, BASE_OPTS, mockHttpRequest(resp));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'http-error');
    assert.equal(result.detail, 503);
});

test('404 response returns http-error (not wrong-content-type)', async () => {
    const resp = makeResponse({ status: 404, headers: {} });
    const result = await fetchFromHarper(TARGET, BASE_OPTS, mockHttpRequest(resp));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'http-error');
    assert.equal(result.detail, 404);
});

test('500 response returns http-error', async () => {
    const resp = makeResponse({ status: 500, headers: { 'content-type': 'text/markdown' } });
    const result = await fetchFromHarper(TARGET, BASE_OPTS, mockHttpRequest(resp));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'http-error');
    assert.equal(result.detail, 500);
});

// ---------------------------------------------------------------------------
// retry-after
// ---------------------------------------------------------------------------

test('retry-after header on any response returns retry-after', async () => {
    const resp = makeResponse({
        status: 503,
        headers: { 'content-type': 'text/markdown', 'retry-after': '300' },
    });
    // retry-after check happens after 5xx check — 503 is caught first
    // Test with a 200 + retry-after to exercise the specific branch
    const resp200 = makeResponse({
        status: 200,
        headers: { 'content-type': 'text/markdown', 'retry-after': '300' },
    });
    const result = await fetchFromHarper(TARGET, BASE_OPTS, mockHttpRequest(resp200));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'retry-after');
    assert.equal(result.detail, '300');
});

// ---------------------------------------------------------------------------
// wrong-content-type
// ---------------------------------------------------------------------------

test('200 with application/octet-stream but x-markdown-version header returns ok:true', async () => {
    const resp = makeResponse({
        status: 200,
        headers: {
            'content-type': 'application/octet-stream',
            'content-encoding': 'gzip',
            'x-markdown-version': '1.3.0',
        },
    });
    const result = await fetchFromHarper(TARGET, BASE_OPTS, mockHttpRequest(resp));
    assert.equal(result.ok, true);
    assert.equal(result.response, resp);
});

test('200 with text/html content-type returns wrong-content-type', async () => {
    const resp = makeResponse({
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
    });
    const result = await fetchFromHarper(TARGET, BASE_OPTS, mockHttpRequest(resp));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'wrong-content-type');
    assert.equal(result.detail, 'text/html; charset=utf-8');
});

test('200 with missing content-type returns wrong-content-type', async () => {
    const resp = makeResponse({ status: 200, headers: {} });
    const result = await fetchFromHarper(TARGET, BASE_OPTS, mockHttpRequest(resp));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'wrong-content-type');
    assert.equal(result.detail, '');
});

// ---------------------------------------------------------------------------
// network-error / timeout
// ---------------------------------------------------------------------------

test('thrown error without "timeout" in message returns network-error', async () => {
    const result = await fetchFromHarper(TARGET, BASE_OPTS,
        mockHttpRequestThrowing('Connection refused'));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'network-error');
    assert.equal(result.detail, 'Connection refused');
});

test('thrown error with "timeout" in message returns timeout', async () => {
    const result = await fetchFromHarper(TARGET, BASE_OPTS,
        mockHttpRequestThrowing('Request timeout after 1500ms'));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'timeout');
});

// ---------------------------------------------------------------------------
// Request shape — headers and URL
// ---------------------------------------------------------------------------

test('Authorization header is set to Bearer <token>', async () => {
    let capturedHeaders;
    const capture = async (_url, opts) => {
        capturedHeaders = opts.headers;
        return makeResponse({ status: 200, headers: { 'content-type': 'text/markdown' } });
    };
    await fetchFromHarper(TARGET, BASE_OPTS, capture);
    assert.deepEqual(capturedHeaders['Authorization'], ['Bearer tok']);
});

test('URL without query string: X-Query-String header is absent', async () => {
    let capturedHeaders;
    const capture = async (_url, opts) => {
        capturedHeaders = opts.headers;
        return makeResponse({ status: 200, headers: { 'content-type': 'text/markdown' } });
    };
    await fetchFromHarper(TARGET, BASE_OPTS, capture);
    assert.equal(capturedHeaders['X-Query-String'], undefined);
});

test('URL with query string: X-Query-String header is set', async () => {
    let capturedHeaders;
    const capture = async (_url, opts) => {
        capturedHeaders = opts.headers;
        return makeResponse({ status: 200, headers: { 'content-type': 'text/markdown' } });
    };
    await fetchFromHarper(TARGET_QS, BASE_OPTS, capture);
    assert.deepEqual(capturedHeaders['X-Query-String'], ['?foo=bar']);
});

test('URL with query string: path in Harper URL is encoded without query string', async () => {
    let capturedUrl;
    const capture = async (url, _opts) => {
        capturedUrl = url;
        return makeResponse({ status: 200, headers: { 'content-type': 'text/markdown' } });
    };
    await fetchFromHarper(TARGET_QS, BASE_OPTS, capture);
    assert.ok(capturedUrl.includes(encodeURIComponent('https://example.com/page')),
        'path should be encoded in the Harper URL');
    assert.ok(!capturedUrl.includes('foo=bar'),
        'query string should not appear in the encoded path');
});

test('timeout option is passed to httpRequest', async () => {
    let capturedOpts;
    const capture = async (_url, opts) => {
        capturedOpts = opts;
        return makeResponse({ status: 200, headers: { 'content-type': 'text/markdown' } });
    };
    await fetchFromHarper(TARGET, BASE_OPTS, capture);
    assert.equal(capturedOpts.timeout, 1500);
});

test('bot-key header (x-pr-req-key) defaults to the token value', async () => {
    let capturedHeaders;
    const capture = async (_url, opts) => {
        capturedHeaders = opts.headers;
        return makeResponse({ status: 200, headers: { 'content-type': 'text/markdown' } });
    };
    await fetchFromHarper(TARGET, BASE_OPTS, capture);
    assert.deepEqual(capturedHeaders['x-pr-req-key'], ['tok']);
});

test('bot-key header uses options.botKey when provided', async () => {
    let capturedHeaders;
    const capture = async (_url, opts) => {
        capturedHeaders = opts.headers;
        return makeResponse({ status: 200, headers: { 'content-type': 'text/markdown' } });
    };
    await fetchFromHarper(TARGET, { ...BASE_OPTS, botKey: 'secret-key' }, capture);
    assert.deepEqual(capturedHeaders['x-pr-req-key'], ['secret-key']);
});

// ---------------------------------------------------------------------------
// fetchHtmlFromHarper — HTML delivery path for humans / SEO crawlers
// ---------------------------------------------------------------------------

test('HTML: 200 with text/html returns ok:true with response object', async () => {
    const resp = makeResponse({
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' },
    });
    const result = await fetchHtmlFromHarper(TARGET, BASE_OPTS, mockHttpRequest(resp));
    assert.equal(result.ok, true);
    assert.equal(result.response, resp);
});

test('HTML: 503 returns http-error so the edge falls back to origin', async () => {
    const resp = makeResponse({ status: 503, headers: { 'content-type': 'text/html' } });
    const result = await fetchHtmlFromHarper(TARGET, BASE_OPTS, mockHttpRequest(resp));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'http-error');
    assert.equal(result.detail, 503);
});

test('HTML: 200 with text/markdown returns wrong-content-type', async () => {
    const resp = makeResponse({ status: 200, headers: { 'content-type': 'text/markdown' } });
    const result = await fetchHtmlFromHarper(TARGET, BASE_OPTS, mockHttpRequest(resp));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'wrong-content-type');
    assert.equal(result.detail, 'text/markdown');
});

test('HTML: timeout in thrown message maps to timeout reason', async () => {
    const result = await fetchHtmlFromHarper(TARGET, BASE_OPTS,
        mockHttpRequestThrowing('socket timeout'));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'timeout');
});

test('HTML: request targets /page/ with encoded url and deviceType', async () => {
    let capturedUrl;
    const capture = async (url, _opts) => {
        capturedUrl = url;
        return makeResponse({ status: 200, headers: { 'content-type': 'text/html' } });
    };
    await fetchHtmlFromHarper(TARGET_QS, { ...BASE_OPTS, deviceType: 'mobile' }, capture);
    assert.ok(capturedUrl.startsWith('https://harper.example.com/page/?url='),
        'should hit the /page/ delivery endpoint');
    assert.ok(capturedUrl.includes(encodeURIComponent(TARGET_QS)),
        'full target URL (incl. query) should be encoded into ?url=');
    assert.ok(capturedUrl.includes('deviceType=mobile'),
        'deviceType should be forwarded');
});

test('HTML: deviceType defaults to desktop', async () => {
    let capturedUrl;
    const capture = async (url, _opts) => {
        capturedUrl = url;
        return makeResponse({ status: 200, headers: { 'content-type': 'text/html' } });
    };
    await fetchHtmlFromHarper(TARGET, BASE_OPTS, capture);
    assert.ok(capturedUrl.includes('deviceType=desktop'));
});
