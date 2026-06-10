#!/usr/bin/env node

/**
 * Mock Harper server for local end-to-end verification of the EdgeWorker.
 *
 * Serves BOTH delivery endpoints of the unified prerender component:
 *   - GET /page_content?path=<url>   → Markdown   (AI crawler path)
 *   - GET /page/?url=<url>           → HTML        (human / SEO path)
 *
 * Scenario is selected via ?scenario=<name> on any request. Defaults to 'success'.
 *
 * Usage:
 *   node scripts/mock-harper-server.js          # listens on port 4000
 *
 * Markdown (/page_content) scenarios:
 *   success            200, text/markdown, gzip
 *   http-error         503, text/markdown (no gzip)        → edge falls back to Fermyon
 *   wrong-content-type 200, text/html                      → edge falls back to Fermyon
 *   retry-after        503, Retry-After: 300               → edge falls back to Fermyon
 *   timeout            waits 5s before responding          → edge falls back to Fermyon
 *   network-error      closes connection immediately       → edge falls back to Fermyon
 *
 * HTML (/page) scenarios:
 *   success            200, text/html, gzip
 *   http-error         503, text/html (no gzip)            → edge falls back to origin
 *   wrong-content-type 200, text/markdown                  → edge falls back to origin
 *   timeout            waits 5s before responding          → edge falls back to origin
 *   network-error      closes connection immediately       → edge falls back to origin
 *
 * Verify Markdown cache-hit:
 *   curl -s -i -H "x-pr-req-key: test" \
 *     "http://localhost:4000/page_content?path=https://example.com"
 *
 * Verify HTML cache-hit:
 *   curl -s -i -H "x-pr-req-key: test" \
 *     "http://localhost:4000/page/?url=https://example.com&deviceType=desktop"
 */

import http from 'node:http';
import zlib from 'node:zlib';

const PORT = 4000;

const FIXTURE_MD = '# Quantum Widget Pro\n\nMarkdown derived from prerendered HTML and served from Harper.\n';
const FIXTURE_MD_GZ = zlib.gzipSync(Buffer.from(FIXTURE_MD, 'utf8'));

const FIXTURE_HTML =
	'<!DOCTYPE html><html><head><title>Quantum Widget Pro</title></head>' +
	'<body><h1>Quantum Widget Pro</h1><p>Prerendered HTML served from Harper.</p></body></html>\n';
const FIXTURE_HTML_GZ = zlib.gzipSync(Buffer.from(FIXTURE_HTML, 'utf8'));

function getScenario(url) {
	try {
		return new URL(url, 'http://localhost').searchParams.get('scenario') || 'success';
	} catch {
		return 'success';
	}
}

function endpointOf(url) {
	const path = url.split('?')[0];
	if (path.startsWith('/page_content')) return 'markdown';
	if (path.startsWith('/page')) return 'html';
	return 'unknown';
}

const server = http.createServer((req, res) => {
	const scenario = getScenario(req.url);
	const endpoint = endpointOf(req.url);
	console.log(`[mock-harper] ${req.method} ${req.url}  endpoint=${endpoint} scenario=${scenario}`);

	if (scenario === 'network-error') {
		req.socket.destroy();
		return;
	}
	if (scenario === 'timeout') {
		setTimeout(() => {
			res.writeHead(200, { 'Content-Type': endpoint === 'html' ? 'text/html' : 'text/markdown' });
			res.end('late\n');
		}, 5000);
		return;
	}

	if (endpoint === 'markdown') {
		switch (scenario) {
			case 'success':
				res.writeHead(200, {
					'Content-Type': 'text/markdown; charset=utf-8',
					'Content-Encoding': 'gzip',
					'Cache-Control': 'public, max-age=3600',
					'Last-Modified': new Date().toUTCString(),
				});
				return res.end(FIXTURE_MD_GZ);
			case 'http-error':
				res.writeHead(503, { 'Content-Type': 'text/markdown; charset=utf-8' });
				return res.end('# Service Unavailable\n');
			case 'wrong-content-type':
				res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
				return res.end('<html><body>not markdown</body></html>');
			case 'retry-after':
				res.writeHead(503, { 'Content-Type': 'text/markdown; charset=utf-8', 'Retry-After': '300' });
				return res.end('# Service Unavailable\n');
			default:
				res.writeHead(400, { 'Content-Type': 'text/plain' });
				return res.end(`Unknown scenario: ${scenario}\n`);
		}
	}

	if (endpoint === 'html') {
		switch (scenario) {
			case 'success':
				res.writeHead(200, {
					'Content-Type': 'text/html; charset=utf-8',
					'Content-Encoding': 'gzip',
					'Cache-Control': 'public, max-age=3600',
					'X-Harper-Rendered': '1',
				});
				return res.end(FIXTURE_HTML_GZ);
			case 'http-error':
				res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
				return res.end('<html><body>Service Unavailable</body></html>');
			case 'wrong-content-type':
				res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
				return res.end('# not html');
			default:
				res.writeHead(400, { 'Content-Type': 'text/plain' });
				return res.end(`Unknown scenario: ${scenario}\n`);
		}
	}

	res.writeHead(404, { 'Content-Type': 'text/plain' });
	res.end('Unknown endpoint — use /page_content or /page\n');
});

server.listen(PORT, () => {
	console.log(`Mock Harper server listening on http://localhost:${PORT}`);
	console.log('Endpoints: /page_content (markdown), /page (html)');
	console.log('Scenarios: success, http-error, wrong-content-type, retry-after, timeout, network-error');
});
