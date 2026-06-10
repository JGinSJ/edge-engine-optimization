#!/usr/bin/env node
'use strict';

/**
 * Harper Markdown Prerender — bulk cache pre-population script
 *
 * Usage:
 *   # Sitemap mode
 *   HARPER_OPS_URL=https://... HARPER_ADMIN_USER=... HARPER_ADMIN_PASS=... \
 *     node scripts/harper-bulk-upload.js --sitemap https://example.com/sitemap.xml
 *
 *   # URL list mode
 *   HARPER_OPS_URL=https://... HARPER_ADMIN_USER=... HARPER_ADMIN_PASS=... \
 *     node scripts/harper-bulk-upload.js --urls https://example.com/a https://example.com/b
 *
 *   # Sitemap index (contains links to other sitemaps)
 *   ... node scripts/harper-bulk-upload.js \
 *     --sitemap https://example.com/sitemap-index.xml --is-index
 *
 * Optional flags:
 *   --refresh-interval <ms>          Page refresh interval (default: 864000000 = 10 days)
 *   --sitemap-refresh-interval <ms>  Sitemap re-fetch interval (default: 2x page interval)
 *   --dry-run                        Print the request body without sending
 *
 * HARPER_OPS_URL    — Harper node URL (full gq4-* hostname, port 443) for /bulk_upload/
 * HARPER_ADMIN_USER — HarperDB admin username (Basic auth)
 * HARPER_ADMIN_PASS — HarperDB admin password (Basic auth)
 * HARPER_URL        — Harper delivery URL, used by the EdgeWorker for /page_content (not used here)
 */

import https from 'https';
import http  from 'http';

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------
const HARPER_OPS_URL    = process.env.HARPER_OPS_URL;
const HARPER_ADMIN_USER = process.env.HARPER_ADMIN_USER;
const HARPER_ADMIN_PASS = process.env.HARPER_ADMIN_PASS;

if (!HARPER_OPS_URL || !HARPER_ADMIN_USER || !HARPER_ADMIN_PASS) {
    console.error('Error: HARPER_OPS_URL, HARPER_ADMIN_USER, and HARPER_ADMIN_PASS environment variables are required.');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

function flagIndex(name)  { return args.indexOf(name); }
function flagValue(name)  { const i = flagIndex(name); return i >= 0 ? args[i + 1] : null; }
function flagPresent(name){ return flagIndex(name) >= 0; }

const sitemapUrl            = flagValue('--sitemap');
const isIndex               = flagPresent('--is-index');
const dryRun                = flagPresent('--dry-run');
const pageRefreshInterval   = parseInt(flagValue('--refresh-interval')         ?? '864000000', 10);
const sitemapRefreshInterval= parseInt(flagValue('--sitemap-refresh-interval') ?? String(pageRefreshInterval * 2), 10);

// --urls collects all remaining positional values after the flag
const urlsFlag = flagIndex('--urls');
const urlList  = urlsFlag >= 0
    ? args.slice(urlsFlag + 1).filter(a => !a.startsWith('--'))
    : [];

if (!sitemapUrl && urlList.length === 0) {
    console.error('Error: provide --sitemap <url> or --urls <url> [<url> ...]');
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Build request body
// ---------------------------------------------------------------------------
let body;

if (sitemapUrl) {
    body = {
        sitemap:                sitemapUrl,
        isIndex,
        pageRefreshInterval,
        sitemapRefreshInterval,
    };
} else if (urlList.length === 1) {
    body = {
        url:             urlList[0],
        refreshInterval: pageRefreshInterval,
    };
} else {
    body = {
        urlList,
        refreshInterval: pageRefreshInterval,
    };
}

const bodyJson = JSON.stringify(body, null, 2);
const endpoint = '/bulk_upload/';
const parsed   = new URL(HARPER_OPS_URL);

if (dryRun) {
    console.log('Dry run — would POST to:', HARPER_OPS_URL + endpoint);
    console.log('Body:', bodyJson);
    process.exit(0);
}

// ---------------------------------------------------------------------------
// Send request
// ---------------------------------------------------------------------------
const options = {
    hostname: parsed.hostname,
    port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path:     endpoint,
    method:   'POST',
    headers: {
        'Authorization': 'Basic ' + Buffer.from(HARPER_ADMIN_USER + ':' + HARPER_ADMIN_PASS).toString('base64'),
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(bodyJson),
    },
};

const transport = parsed.protocol === 'https:' ? https : http;

console.log('POSTing to', HARPER_OPS_URL + endpoint);
console.log('Mode:', sitemapUrl ? 'sitemap' : urlList.length === 1 ? 'single-url' : 'url-list');
if (sitemapUrl) {
    console.log('Sitemap:', sitemapUrl, isIndex ? '(index)' : '');
    console.log('Page refresh interval:', pageRefreshInterval, 'ms');
    console.log('Sitemap refresh interval:', sitemapRefreshInterval, 'ms');
} else {
    console.log('URLs:', urlList.length);
    console.log('Refresh interval:', pageRefreshInterval, 'ms');
}

const req = transport.request(options, (res) => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => {
        const status = res.statusCode;
        if (status === 201) {
            console.log('201 — all URLs queued successfully.');
        } else if (status === 207) {
            console.log('207 — partial success: some URLs failed, others queued.');
            console.log('Response:', data);
        } else if (status === 400) {
            console.error('400 — invalid or missing parameters.');
            console.error('Response:', data);
            process.exit(1);
        } else {
            console.error(`${status} — unexpected response.`);
            console.error('Response:', data);
            process.exit(1);
        }
    });
});

req.on('error', (err) => {
    console.error('Network error:', err.message);
    process.exit(1);
});

req.write(bodyJson);
req.end();
