import { test } from 'node:test';
import assert from 'node:assert/strict';
import { urlToKey, readMarkdown, harperAuthHeader } from './harper-read.js';

// Mock the Akamai httpRequest: capture url/options, return a fake response.
function mockHttp(status, body, captured) {
    return async (url, options) => {
        if (captured) { captured.url = url; captured.options = options; }
        return { status, text: async () => body, getHeader: () => [] };
    };
}
const CFG = { baseUrl: '/_harper', token: 'tok', timeoutMs: 1500 };

test('urlToKey: URL-safe base64, no padding', () => {
    assert.equal(urlToKey('https://example.org'), 'aHR0cHM6Ly9leGFtcGxlLm9yZw');
});

test('harperAuthHeader: Basic when user set, matches standard base64', () => {
    const expected = 'Basic ' + Buffer.from('admin:p@ss:word').toString('base64');
    assert.equal(harperAuthHeader({ user: 'admin', pass: 'p@ss:word' }), expected);
});

test('harperAuthHeader: falls back to Bearer when no user', () => {
    assert.equal(harperAuthHeader({ token: 'tok' }), 'Bearer tok');
    assert.equal(harperAuthHeader({}), 'Bearer ');
});

test('readMarkdown: uses provided authHeader (Basic) verbatim', async () => {
    const cap = {};
    const rec = JSON.stringify({ markdown: '# Hi' });
    await readMarkdown('markdown_cache', 'https://example.org',
        { baseUrl: '/_harper', authHeader: 'Basic YWRtaW46cHc=', timeoutMs: 1500 }, mockHttp(200, rec, cap));
    assert.deepEqual(cap.options.headers['Authorization'], ['Basic YWRtaW46cHc=']);
});

test('markdown_cache: parses JSON record and builds the key URL', async () => {
    const cap = {};
    const rec = JSON.stringify({ url: 'k', markdown: '# Hi', cached_at: 'x', content_type: 'text/markdown' });
    const r = await readMarkdown('markdown_cache', 'https://example.org', CFG, mockHttp(200, rec, cap));
    assert.deepEqual(r, { ok: true, markdown: '# Hi' });
    assert.equal(cap.url, '/_harper/markdown_cache/aHR0cHM6Ly9leGFtcGxlLm9yZw');
});

test('markdown_cache: 404 → cache-miss', async () => {
    const r = await readMarkdown('markdown_cache', 'https://example.org', CFG, mockHttp(404, '', {}));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'cache-miss');
});

test('page_content: returns body as markdown, builds path URL, sends X-Query-String', async () => {
    const cap = {};
    const r = await readMarkdown('page_content', 'https://site.com/p?a=1', CFG, mockHttp(200, '# Page', cap));
    assert.deepEqual(r, { ok: true, markdown: '# Page' });
    assert.equal(cap.url, '/_harper/page_content?path=' + encodeURIComponent('https://site.com/p'));
    assert.deepEqual(cap.options.headers['X-Query-String'], ['?a=1']);
});

test('page_content: non-2xx → http-error with body + status', async () => {
    const r = await readMarkdown('page_content', 'https://site.com/', CFG, mockHttp(500, 'boom', {}));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'http-error');
    assert.equal(r.detail, 500);
    assert.equal(r.body, 'boom');
});

test('default read mode is markdown_cache', async () => {
    const cap = {};
    await readMarkdown(undefined, 'https://example.org', CFG, mockHttp(404, '', cap));
    assert.match(cap.url, /\/markdown_cache\//);
});

test('empty markdown → no-markdown', async () => {
    const rec = JSON.stringify({ url: 'k', markdown: '' });
    const r = await readMarkdown('markdown_cache', 'https://example.org', CFG, mockHttp(200, rec, {}));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-markdown');
});
