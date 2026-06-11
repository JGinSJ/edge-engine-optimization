import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	DEFAULT_CRAWLER_POLICY,
	parseCrawlerPolicy,
	detectBotKind,
	resolveRepresentation,
} from './crawler-policy.js';

// ── parseCrawlerPolicy ───────────────────────────────────────────────────────
test('parseCrawlerPolicy parses valid pairs and ignores junk', () => {
	assert.deepEqual(
		parseCrawlerPolicy('googlebot=html, gptbot=markdown ,Bingbot=HTML'),
		{ googlebot: 'html', gptbot: 'markdown', bingbot: 'html' }
	);
});
test('parseCrawlerPolicy drops invalid representations and empties', () => {
	assert.deepEqual(parseCrawlerPolicy('googlebot=xml,foo=,=html,claudebot=markdown'), { claudebot: 'markdown' });
	assert.deepEqual(parseCrawlerPolicy(''), {});
	assert.deepEqual(parseCrawlerPolicy(undefined), {});
});

// ── detectBotKind ────────────────────────────────────────────────────────────
test('explicit X-Bot-Kind header wins over UA', () => {
	assert.equal(detectBotKind('GPTBot', 'Mozilla/5.0 ... Googlebot/2.1'), 'gptbot');
});
test('human/none header means no bot', () => {
	assert.equal(detectBotKind('human', 'GPTBot'), null);
	assert.equal(detectBotKind('none', ''), null);
});
test('falls back to UA when no header', () => {
	assert.equal(detectBotKind('', 'Mozilla/5.0 (compatible; ClaudeBot/1.0)'), 'claudebot');
	assert.equal(detectBotKind(null, 'Mozilla/5.0 AppleWebKit (KHTML) Chrome Safari'), null);
});
test('UA disambiguation: more specific patterns win', () => {
	assert.equal(detectBotKind('', 'OAI-SearchBot/1.0'), 'oai-searchbot'); // not gptbot
	assert.equal(detectBotKind('', 'Mozilla/5.0 (compatible; Google-Extended)'), 'google-extended'); // not googlebot
});

// ── resolveRepresentation ────────────────────────────────────────────────────
test('per-crawler default policy: Google→html, AI bots→markdown', () => {
	assert.equal(resolveRepresentation({ botKind: 'googlebot', acceptsMarkdown: false }), 'html');
	assert.equal(resolveRepresentation({ botKind: 'bingbot', acceptsMarkdown: false }), 'html');
	for (const k of ['claudebot', 'gptbot', 'perplexitybot', 'oai-searchbot', 'google-extended']) {
		assert.equal(resolveRepresentation({ botKind: k, acceptsMarkdown: false }), 'markdown', k);
	}
});
test('PMUSER override beats the default (e.g. OpenAI→html)', () => {
	const policy = parseCrawlerPolicy('gptbot=html');
	assert.equal(resolveRepresentation({ botKind: 'gptbot', acceptsMarkdown: false, policy }), 'html');
});
test('Accept: text/markdown forces markdown when no bot policy', () => {
	assert.equal(resolveRepresentation({ botKind: null, acceptsMarkdown: true }), 'markdown');
});
test('generic AI UA (no specific kind) → markdown', () => {
	assert.equal(resolveRepresentation({ botKind: null, acceptsMarkdown: false, isAiUa: true }), 'markdown');
});
test('backward compatible: plain human → html', () => {
	assert.equal(resolveRepresentation({ botKind: null, acceptsMarkdown: false, isAiUa: false }), 'html');
});
test('explicit policy wins even over Accept header', () => {
	// A googlebot that (oddly) sends Accept: text/markdown still gets html per policy.
	assert.equal(resolveRepresentation({ botKind: 'googlebot', acceptsMarkdown: true }), 'html');
});
test('DEFAULT_CRAWLER_POLICY is the documented split', () => {
	assert.equal(DEFAULT_CRAWLER_POLICY.googlebot, 'html');
	assert.equal(DEFAULT_CRAWLER_POLICY.gptbot, 'markdown');
});
