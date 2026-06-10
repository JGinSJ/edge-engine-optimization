#!/usr/bin/env node

/**
 * Render-tuning probe — the CLI "knob".
 *
 * Renders a URL through Harper's /render_preview with caller-supplied options and
 * prints the result (status, sizes, timing) plus a Markdown sample. Ephemeral:
 * it does not require the URL to be a managed page and does not write the cache,
 * so it's safe for rapid wait-strategy experimentation. The demo UI's "Render
 * Lab" hits the same endpoint.
 *
 * Usage:
 *   HARPER_URL=http://localhost:9926 node scripts/harper-render-probe.js \
 *     --url https://www.verizon.com/business/shop/products/devices/smartphones/apple-iphone-17-pro-max \
 *     --wait domcontentloaded --settle 12000 --idle 600 --selector "h1" --show md
 *
 * Flags:
 *   --url <url>          (required) URL to render
 *   --device <type>      desktop | mobile | tablet (default desktop)
 *   --wait <event>       load | domcontentloaded | networkidle0 | networkidle2
 *   --settle <ms>        max wait for network-idle after nav (0 disables)
 *   --idle <ms>          idle window that counts as settled
 *   --selector <css>     wait for this selector before snapshotting
 *   --show <what>        md | html | none   (default md — prints a sample)
 *   --chars <n>          sample length to print (default 1200)
 *
 * Env:
 *   HARPER_URL      Harper delivery base URL (default http://localhost:9926)
 *   HARPER_BOT_KEY  value for the x-pr-req-key header (default empty)
 */

const HARPER_URL = process.env.HARPER_URL || 'http://localhost:9926';
const BOT_KEY = process.env.HARPER_BOT_KEY ?? '';

const args = process.argv.slice(2);
const val = (name, def = null) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };

const url = val('--url');
if (!url) {
	console.error('Error: --url <url> is required');
	process.exit(1);
}

const qs = new URLSearchParams({ url });
const device = val('--device'); if (device) qs.set('deviceType', device);
const wait = val('--wait'); if (wait) qs.set('waitUntil', wait);
const settle = val('--settle'); if (settle != null) qs.set('settleMs', settle);
const idle = val('--idle'); if (idle != null) qs.set('idleMs', idle);
const selector = val('--selector'); if (selector) qs.set('selector', selector);

const show = val('--show', 'md');
const chars = parseInt(val('--chars', '1200'), 10);

const endpoint = `${HARPER_URL.replace(/\/$/, '')}/render_preview?${qs.toString()}`;

console.log(`→ ${endpoint}\n`);

const res = await fetch(endpoint, { headers: { 'x-pr-req-key': BOT_KEY } }).catch((err) => {
	console.error('Request failed:', err.message);
	process.exit(1);
});

const data = await res.json().catch(() => ({}));
if (!res.ok && res.status !== 200) {
	console.error(`HTTP ${res.status}`, data);
	process.exit(1);
}

const eo = data.effectiveOptions || {};
console.log(`status            : ${data.statusCode}  (ok=${data.ok})`);
console.log(`html bytes        : ${data.htmlBytes}`);
console.log(`markdown bytes    : ${data.markdownBytes}`);
console.log(`render time (page): ${data.renderTimeMs ?? 'n/a'} ms`);
console.log(`elapsed (total)   : ${data.elapsedMs} ms`);
console.log(`waitUntil         : ${eo.waitUntil}`);
console.log(`settleTimeoutMs   : ${eo.settleTimeoutMs}`);
console.log(`networkIdleMs     : ${eo.networkIdleMs}`);
console.log(`waitForSelector   : ${eo.waitForSelector ?? '(none)'}`);

if (show === 'md' && data.markdown) {
	console.log('\n--- markdown sample ---');
	console.log(data.markdown.slice(0, chars));
} else if (show === 'html' && data.html) {
	console.log('\n--- html sample ---');
	console.log(data.html.slice(0, chars));
}

process.exit(data.ok ? 0 : 2);
