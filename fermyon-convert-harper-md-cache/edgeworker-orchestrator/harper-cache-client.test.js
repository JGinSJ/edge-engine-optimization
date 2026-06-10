import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readCache, writeCache } from './harper-cache-client.js';

const BASE_CONFIG = { baseUrl: 'https://harper.example.com', token: 'tok123', timeoutMs: 1500 };
const WRITE_CONFIG = { baseUrl: 'https://harper.example.com', token: 'tok123', timeoutMs: 500 };
const TARGET_URL = 'https://example.com/products/widget';

function makeResponse({ status = 200, headers = {}, textBody = '' } = {}) {
    const normalised = {};
    for (const [k, v] of Object.entries(headers)) {
        normalised[k.toLowerCase()] = Array.isArray(v) ? v : [v];
    }
    return {
        status,
        ok: status >= 200 && status < 300,
        getHeader(name) { return normalised[name.toLowerCase()] ?? null; },
        async text() { return textBody; },
    };
}

function mockHttpRequest(response) {
    let captured = null;
    const fn = async (url, opts) => {
        captured = { url, opts };
        return response;
    };
    fn.captured = () => captured;
    return fn;
}

function mockHttpRequestThrowing(error) {
    return async () => { throw error; };
}

// ---------------------------------------------------------------------------
// readCache
// ---------------------------------------------------------------------------
describe('readCache', () => {
    it('returns markdown string on cache hit (200 with JSON)', async () => {
        const body = JSON.stringify({ url: TARGET_URL, markdown: '# Hello', cached_at: '2026-01-01T00:00:00Z', content_type: 'text/markdown' });
        const mock = mockHttpRequest(makeResponse({ status: 200, textBody: body }));
        const result = await readCache(TARGET_URL, BASE_CONFIG, mock);
        assert.equal(result.ok, true);
        assert.equal(result.markdown, '# Hello');
    });

    it('returns cache-miss on 404', async () => {
        const mock = mockHttpRequest(makeResponse({ status: 404 }));
        const result = await readCache(TARGET_URL, BASE_CONFIG, mock);
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'cache-miss');
    });

    it('returns http-error on 500', async () => {
        const mock = mockHttpRequest(makeResponse({ status: 500 }));
        const result = await readCache(TARGET_URL, BASE_CONFIG, mock);
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'http-error');
        assert.equal(result.detail, 500);
    });

    it('returns timeout on timeout error', async () => {
        const mock = mockHttpRequestThrowing(new Error('Request timeout exceeded'));
        const result = await readCache(TARGET_URL, BASE_CONFIG, mock);
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'timeout');
    });

    it('returns network-error on other thrown errors', async () => {
        const mock = mockHttpRequestThrowing(new Error('ECONNREFUSED'));
        const result = await readCache(TARGET_URL, BASE_CONFIG, mock);
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'network-error');
    });

    it('returns no-markdown when markdown field is empty', async () => {
        const body = JSON.stringify({ url: TARGET_URL, markdown: '', cached_at: '2026-01-01T00:00:00Z' });
        const mock = mockHttpRequest(makeResponse({ status: 200, textBody: body }));
        const result = await readCache(TARGET_URL, BASE_CONFIG, mock);
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'no-markdown');
    });

    it('returns no-markdown when body is invalid JSON', async () => {
        const mock = mockHttpRequest(makeResponse({ status: 200, textBody: 'not json' }));
        const result = await readCache(TARGET_URL, BASE_CONFIG, mock);
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'no-markdown');
        assert.equal(result.detail, 'invalid-json');
    });

    it('constructs the correct URL with base64 key', async () => {
        const mock = mockHttpRequest(makeResponse({ status: 404 }));
        await readCache(TARGET_URL, BASE_CONFIG, mock);
        const captured = mock.captured();
        const expectedKey = btoa(TARGET_URL).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
        assert.equal(captured.url, 'https://harper.example.com/markdown_cache/' + expectedKey);
    });

    it('sends Authorization header with Bearer token', async () => {
        const mock = mockHttpRequest(makeResponse({ status: 404 }));
        await readCache(TARGET_URL, BASE_CONFIG, mock);
        const captured = mock.captured();
        assert.deepEqual(captured.opts.headers['Authorization'], ['Bearer tok123']);
    });

    it('does not pass timeout option to httpRequest', async () => {
        const mock = mockHttpRequest(makeResponse({ status: 404 }));
        await readCache(TARGET_URL, BASE_CONFIG, mock);
        const captured = mock.captured();
        assert.equal(captured.opts.timeout, undefined);
    });
});

// ---------------------------------------------------------------------------
// writeCache
// ---------------------------------------------------------------------------
describe('writeCache', () => {
    it('returns ok on 200', async () => {
        const mock = mockHttpRequest(makeResponse({ status: 200 }));
        const result = await writeCache(TARGET_URL, '# Hello', WRITE_CONFIG, mock);
        assert.equal(result.ok, true);
    });

    it('returns ok on 201', async () => {
        const mock = mockHttpRequest(makeResponse({ status: 201 }));
        const result = await writeCache(TARGET_URL, '# Hello', WRITE_CONFIG, mock);
        assert.equal(result.ok, true);
    });

    it('returns http-error on 500', async () => {
        const mock = mockHttpRequest(makeResponse({ status: 500 }));
        const result = await writeCache(TARGET_URL, '# Hello', WRITE_CONFIG, mock);
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'http-error');
        assert.equal(result.detail, 500);
    });

    it('returns timeout on timeout error', async () => {
        const mock = mockHttpRequestThrowing(new Error('Request timeout exceeded'));
        const result = await writeCache(TARGET_URL, '# Hello', WRITE_CONFIG, mock);
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'timeout');
    });

    it('returns network-error on other thrown errors', async () => {
        const mock = mockHttpRequestThrowing(new Error('ECONNREFUSED'));
        const result = await writeCache(TARGET_URL, '# Hello', WRITE_CONFIG, mock);
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'network-error');
    });

    it('uses PUT method', async () => {
        const mock = mockHttpRequest(makeResponse({ status: 200 }));
        await writeCache(TARGET_URL, '# Hello', WRITE_CONFIG, mock);
        const captured = mock.captured();
        assert.equal(captured.opts.method, 'PUT');
    });

    it('puts to record endpoint with key in URL', async () => {
        const mock = mockHttpRequest(makeResponse({ status: 200 }));
        await writeCache(TARGET_URL, '# Hello', WRITE_CONFIG, mock);
        const captured = mock.captured();
        const expectedKey = btoa(TARGET_URL).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
        assert.equal(captured.url, 'https://harper.example.com/markdown_cache/' + expectedKey);
    });

    it('sends JSON body with correct fields', async () => {
        const mock = mockHttpRequest(makeResponse({ status: 200 }));
        await writeCache(TARGET_URL, '# Hello', WRITE_CONFIG, mock);
        const captured = mock.captured();
        const body = JSON.parse(captured.opts.body);
        const expectedKey = btoa(TARGET_URL).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
        assert.equal(body.url, expectedKey);
        assert.equal(body.markdown, '# Hello');
        assert.equal(body.content_type, 'text/markdown');
        assert.ok(body.cached_at, 'cached_at should be present');
    });

    it('sends Content-Type, Authorization, and Content-Length headers', async () => {
        const mock = mockHttpRequest(makeResponse({ status: 200 }));
        await writeCache(TARGET_URL, '# Hello', WRITE_CONFIG, mock);
        const captured = mock.captured();
        assert.deepEqual(captured.opts.headers['Content-Type'], ['application/json']);
        assert.deepEqual(captured.opts.headers['Authorization'], ['Bearer tok123']);
        const body = captured.opts.body;
        assert.deepEqual(captured.opts.headers['Content-Length'], [String(body.length)]);
    });

    it('does not pass timeout option to httpRequest', async () => {
        const mock = mockHttpRequest(makeResponse({ status: 200 }));
        await writeCache(TARGET_URL, '# Hello', WRITE_CONFIG, mock);
        const captured = mock.captured();
        assert.equal(captured.opts.timeout, undefined);
    });
});
