import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoPreset, DEMO_PRESETS } from './demo-presets.js';

test('known scenarios return the right overrides', () => {
    assert.equal(demoPreset('cdn-cache').HARPER_ENABLED, false);
    assert.equal(demoPreset('md-cache').WRITE_THROUGH, true);
    assert.equal(demoPreset('md-cache').HARPER_READ_MODE, 'markdown_cache');
    assert.equal(demoPreset('convert-cache').HARPER_READ_MODE, 'page_content');
    assert.equal(demoPreset('prerender').SERVE_HTML, true);
});

test('trimmed + case-insensitive', () => {
    assert.deepEqual(demoPreset(' MD-Cache '), DEMO_PRESETS['md-cache']);
});

test('unknown / missing → null', () => {
    assert.equal(demoPreset('bogus'), null);
    assert.equal(demoPreset(''), null);
    assert.equal(demoPreset(undefined), null);
    assert.equal(demoPreset(null), null);
});

test('every preset defines all four scenario fields', () => {
    for (const p of Object.values(DEMO_PRESETS)) {
        for (const k of ['HARPER_ENABLED', 'HARPER_READ_MODE', 'WRITE_THROUGH', 'SERVE_HTML']) {
            assert.ok(k in p, `${k} present`);
        }
    }
});
