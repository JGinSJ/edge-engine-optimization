// Demo-mode scenario presets. They let ONE EdgeWorker on ONE property serve every
// scenario, selected per request via the `X-Demo-Scenario` header — gated by
// PMUSER_DEMO_MODE so it only applies on the demo property.
//
// ⚠️ NEVER enable PMUSER_DEMO_MODE on a real customer property: a request could
// flip WRITE_THROUGH / HARPER_ENABLED etc. On a customer property the scenario is
// fixed by the property's PMUSER_* variables, as normal.
//
// Each preset overrides only the four scenario-determining fields; everything else
// (HARPER_URL, HARPER_WRITE_URL, TOKEN, WASM_URL, CRAWLER_POLICY) stays from the
// property config, shared across scenarios on the demo property.
export const DEMO_PRESETS = {
    'cdn-cache':     { HARPER_ENABLED: false, HARPER_READ_MODE: 'markdown_cache', WRITE_THROUGH: false, SERVE_HTML: false },
    'md-cache':      { HARPER_ENABLED: true,  HARPER_READ_MODE: 'markdown_cache', WRITE_THROUGH: true,  SERVE_HTML: false },
    'convert-cache': { HARPER_ENABLED: true,  HARPER_READ_MODE: 'page_content',   WRITE_THROUGH: false, SERVE_HTML: false },
    'prerender':     { HARPER_ENABLED: true,  HARPER_READ_MODE: 'page_content',   WRITE_THROUGH: false, SERVE_HTML: true  },
};

// Returns the config overrides for a scenario id (trimmed, case-insensitive),
// or null if the id is unknown/missing.
export function demoPreset(scenario) {
    const key = String(scenario ?? '').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(DEMO_PRESETS, key) ? DEMO_PRESETS[key] : null;
}
