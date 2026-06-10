#!/usr/bin/env node
'use strict';

/**
 * Pre-populates the Harper markdown_cache by fetching markdown from Fermyon
 * and writing it to Harper via REST PUT.
 *
 * Usage:
 *   HARPER_URL=https://... HARPER_TOKEN=... \
 *     node scripts/cache-warm.js \
 *     https://example.com/page1 https://example.com/page2
 *
 *   # Or from a file (one URL per line):
 *   HARPER_URL=https://... HARPER_TOKEN=... \
 *     node scripts/cache-warm.js --file urls.txt
 *
 * Environment:
 *   HARPER_URL    — Harper REST API base URL (no trailing slash)
 *   HARPER_TOKEN  — Bearer token for Harper
 *   WASM_URL      — Fermyon endpoint (default: existing deployment)
 */

const HARPER_URL   = process.env.HARPER_URL;
const HARPER_TOKEN = process.env.HARPER_TOKEN;
const WASM_URL     = process.env.WASM_URL || 'https://bede2402-c4b7-4234-b17c-5e04fc46ef00.fwf.app';
const TABLE        = 'markdown_cache';

if (!HARPER_URL || !HARPER_TOKEN) {
    console.error('Error: HARPER_URL and HARPER_TOKEN environment variables are required.');
    process.exit(1);
}

const fs = require('fs');

function parseArgs() {
    const args = process.argv.slice(2);
    const urls = [];

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--file' && args[i + 1]) {
            const content = fs.readFileSync(args[i + 1], 'utf8');
            content.split('\n').forEach(line => {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#')) urls.push(trimmed);
            });
            i++;
        } else if (args[i].startsWith('http')) {
            urls.push(args[i]);
        }
    }

    return urls;
}

async function fetchMarkdown(targetUrl) {
    const res = await fetch(WASM_URL, {
        headers: { 'X-Target-URL': targetUrl },
    });
    if (!res.ok) {
        throw new Error(`Fermyon returned ${res.status}`);
    }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('markdown')) {
        throw new Error(`Unexpected content-type: ${ct}`);
    }
    return await res.text();
}

async function writeToHarper(targetUrl, markdown) {
    const url = HARPER_URL + '/' + TABLE + '/' + encodeURIComponent(targetUrl);
    const body = JSON.stringify({
        url: targetUrl,
        markdown,
        cached_at: new Date().toISOString(),
        content_type: 'text/markdown',
    });

    const res = await fetch(url, {
        method: 'PUT',
        headers: {
            'Authorization': 'Bearer ' + HARPER_TOKEN,
            'Content-Type': 'application/json',
        },
        body,
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Harper PUT returned ${res.status}: ${text.slice(0, 200)}`);
    }
}

async function warmUrl(targetUrl) {
    process.stdout.write(`  ${targetUrl} ... `);
    try {
        const markdown = await fetchMarkdown(targetUrl);
        await writeToHarper(targetUrl, markdown);
        console.log(`OK (${(markdown.length / 1024).toFixed(1)} KB)`);
    } catch (err) {
        console.log(`FAILED: ${err.message}`);
    }
}

async function main() {
    const urls = parseArgs();
    if (urls.length === 0) {
        console.error('Usage: node scripts/cache-warm.js [--file urls.txt] [url1] [url2] ...');
        process.exit(1);
    }

    console.log(`\nHarper Cache Warm — ${urls.length} URL(s)`);
    console.log(`  Harper: ${HARPER_URL}`);
    console.log(`  Fermyon: ${WASM_URL}\n`);

    for (const url of urls) {
        await warmUrl(url);
    }

    console.log('\nDone.');
}

main();
