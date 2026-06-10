#!/usr/bin/env node

/**
 * Minimal static origin that serves the client-side-rendered demo page on every
 * path. Used by docker-compose as the "origin" the Harper renderer prerenders,
 * to demonstrate the CSR gap end-to-end (empty shell on raw fetch vs. full
 * content after headless rendering).
 *
 * Usage:  PORT=8080 node scripts/csr-sample/server.js
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = parseInt(process.env.PORT || '8080', 10);
const HTML = fs.readFileSync(path.join(import.meta.dirname, 'index.html'), 'utf8');

const server = http.createServer((req, res) => {
	console.log(`[csr-origin] ${req.method} ${req.url}`);
	if (req.url === '/healthz') {
		res.writeHead(200, { 'Content-Type': 'text/plain' });
		res.end('ok');
		return;
	}
	res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
	res.end(HTML);
});

server.listen(PORT, () => {
	console.log(`CSR sample origin listening on http://0.0.0.0:${PORT}`);
});
