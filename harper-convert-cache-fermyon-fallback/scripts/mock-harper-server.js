#!/usr/bin/env node
'use strict';

/**
 * Mock Harper server for local end-to-end verification.
 *
 * Listens on port 4000. Scenario is selected via ?scenario=<name> appended
 * to any request path. Defaults to 'success' when omitted.
 *
 * Usage:
 *   node scripts/mock-harper-server.js
 *
 * Scenarios:
 *   success          200, Content-Type: text/markdown, Content-Encoding: gzip
 *   http-error       503, Content-Type: text/markdown (no gzip)
 *   wrong-content-type  200, Content-Type: text/html
 *   retry-after      503, Retry-After: 300
 *   timeout          Accepts connection, waits 5s before responding
 *   network-error    Closes connection immediately
 *
 * Verify cache-hit path:
 *   curl -s -i -H "Authorization: Basic dGVzdDp0ZXN0" \
 *     "http://localhost:4000/page_content?path=https://example.com"
 *
 * Verify fallback (http-error) path:
 *   curl -s -i -H "Authorization: Basic dGVzdDp0ZXN0" \
 *     "http://localhost:4000/page_content?path=https://example.com&scenario=http-error"
 */

const http = require('http');
const zlib = require('zlib');

const PORT = 4000;

// Pre-compress the fixture markdown at startup
const FIXTURE_MD = '# WorkHarder\n\nConverted Markdown content served from Harper cache.\n';
const FIXTURE_GZ = zlib.gzipSync(Buffer.from(FIXTURE_MD, 'utf8'));

function getScenario(url) {
    try {
        const u = new URL(url, 'http://localhost');
        return u.searchParams.get('scenario') || 'success';
    } catch {
        return 'success';
    }
}

const server = http.createServer((req, res) => {
    const scenario = getScenario(req.url);
    console.log(`[mock-harper] ${req.method} ${req.url}  scenario=${scenario}`);

    switch (scenario) {
        case 'success':
            res.writeHead(200, {
                'Content-Type':     'text/markdown; charset=utf-8',
                'Content-Encoding': 'gzip',
                'Cache-Control':    'public, max-age=864000',
                'Last-Modified':    new Date().toUTCString(),
            });
            res.end(FIXTURE_GZ);
            break;

        case 'http-error':
            res.writeHead(503, {
                'Content-Type': 'text/markdown; charset=utf-8',
            });
            res.end('# Service Unavailable\n\nHarper could not retrieve the page.\n');
            break;

        case 'wrong-content-type':
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
            });
            res.end('<html><body><p>Fallback HTML response</p></body></html>');
            break;

        case 'retry-after':
            res.writeHead(503, {
                'Content-Type': 'text/markdown; charset=utf-8',
                'Retry-After':  '300',
            });
            res.end('# Service Unavailable\n\nRetry after 300 seconds.\n');
            break;

        case 'timeout':
            // Accept the connection but delay longer than HARPER_TIMEOUT_MS (1500 ms)
            setTimeout(() => {
                res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
                res.end('# Late response\n');
            }, 5000);
            break;

        case 'network-error':
            req.socket.destroy();
            break;

        default:
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end(`Unknown scenario: ${scenario}\n`);
    }
});

server.listen(PORT, () => {
    console.log(`Mock Harper server listening on http://localhost:${PORT}`);
    console.log('Scenarios: success, http-error, wrong-content-type, retry-after, timeout, network-error');
    console.log('');
    console.log('Verify cache-hit path:');
    console.log(`  curl -s -i -H "Authorization: Basic dGVzdDp0ZXN0" "http://localhost:${PORT}/page_content?path=https://example.com"`);
    console.log('');
    console.log('Verify fallback (http-error) path:');
    console.log(`  curl -s -i -H "Authorization: Basic dGVzdDp0ZXN0" "http://localhost:${PORT}/page_content?path=https://example.com&scenario=http-error"`);
});
