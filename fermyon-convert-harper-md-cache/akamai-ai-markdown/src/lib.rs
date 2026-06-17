use spin_sdk::http::{IntoResponse, Method, Request, Response, send};
use spin_sdk::http_component;
use html2md::parse_html;

// Removes all occurrences of <tag ...>...</tag> blocks (case-insensitive).
// Prevents style/script content from polluting the markdown output.
fn strip_tag_blocks(html: &str, tag: &str) -> String {
    let open_pat = format!("<{}", tag);
    let close_pat = format!("</{}>", tag);
    let lower = html.to_lowercase();
    let open_lower = open_pat.to_lowercase();
    let close_lower = close_pat.to_lowercase();

    let mut result = String::with_capacity(html.len());
    let mut pos = 0;

    while pos < html.len() {
        match lower[pos..].find(&open_lower) {
            None => { result.push_str(&html[pos..]); break; }
            Some(rel) => {
                let start = pos + rel;
                result.push_str(&html[pos..start]);
                match lower[start..].find('>') {
                    None => break,
                    Some(end_open) => {
                        let after_open = start + end_open + 1;
                        match lower[after_open..].find(&close_lower) {
                            None => break,
                            Some(rel_close) => {
                                pos = after_open + rel_close + close_lower.len();
                            }
                        }
                    }
                }
            }
        }
    }
    result
}

// Minimal RFC 8259 string escaper — avoids pulling in serde just to emit one
// flat JSON object. The markdown body is the only field that can contain quotes,
// backslashes, newlines, or control characters, so every string field is escaped.
fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 16);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0C}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

fn header_string(req: &Request, name: &str) -> Option<String> {
    req.header(name)
        .map(|h| String::from_utf8_lossy(h.as_bytes()).to_string())
}

// Write-through to Harper. OPT-IN: only runs when the EdgeWorker forwards the
// X-Harper-* headers — so the shared/other callers that don't send them are
// completely unaffected. Never fails the response; returns a status label that
// the EdgeWorker surfaces as `X-Cache-Write`.
//
// Replicates the EdgeWorker's write contract exactly:
//   PUT {base}/markdown_cache/{key}
//   Authorization: forwarded as X-Harper-Authorization (Basic for Harper Fabric)
//   body { url: key, markdown, cached_at, content_type: "text/markdown" }
// The key is computed EW-side (urlToKey = URL-safe base64) and forwarded as
// X-Harper-Key, so read-key == write-key with no chance of drift. Fermyon can do
// this PUT (full body, port 443) where the EdgeWorker is blocked by edge limits.
async fn write_to_harper(req: &Request, markdown: &str) -> &'static str {
    let (base, key) = match (
        header_string(req, "X-Harper-Url"),
        header_string(req, "X-Harper-Key"),
    ) {
        (Some(b), Some(k)) if !b.is_empty() && !k.is_empty() => (b, k),
        _ => return "skip",
    };
    // Harper Fabric authenticates with HTTP Basic — the EdgeWorker computes the full
    // Authorization value and forwards it as X-Harper-Authorization. Fall back to
    // Bearer + X-Harper-Token for an older EdgeWorker that only sends the token.
    let auth = header_string(req, "X-Harper-Authorization")
        .filter(|a| !a.is_empty())
        .or_else(|| header_string(req, "X-Harper-Token")
            .filter(|t| !t.is_empty())
            .map(|t| format!("Bearer {}", t)));
    let auth = match auth {
        Some(a) => a,
        None => return "skip",
    };
    let cached_at = header_string(req, "X-Harper-Cached-At").unwrap_or_default();

    let body = format!(
        "{{\"url\":\"{}\",\"markdown\":\"{}\",\"cached_at\":\"{}\",\"content_type\":\"text/markdown\"}}",
        json_escape(&key),
        json_escape(markdown),
        json_escape(&cached_at),
    );

    let endpoint = format!("{}/markdown_cache/{}", base.trim_end_matches('/'), key);

    let put_req = Request::builder()
        .method(Method::Put)
        .uri(endpoint)
        .header("authorization", auth)
        .header("content-type", "application/json")
        .body(body.into_bytes())
        .build();

    match send::<_, Response>(put_req).await {
        Ok(resp) => {
            let code = *resp.status() as u16;
            if (200..300).contains(&code) { "ok" } else { "fail" }
        }
        Err(_) => "fail",
    }
}

#[http_component]
async fn handle_ai_markdown(req: Request) -> anyhow::Result<impl IntoResponse> {
    // 1. Extract the target origin URL from the EdgeWorker orchestration layer
    let target_url = match req.header("X-Target-URL") {
        Some(url) => String::from_utf8_lossy(url.as_bytes()).to_string(),
        None => return Ok(Response::builder()
            .status(400)
            .body("Missing X-Target-URL header from EdgeWorker")
            .build()),
    };

    // 2. Fetch the raw HTML using Spin's outbound HTTP capabilities
    let origin_req = Request::get(&target_url);
    let origin_resp: Response = send(origin_req).await.map_err(|e| anyhow::anyhow!("Request failed: {:?}", e))?;

    let status = origin_resp.status();
    // Returning 502 causes wasmResponse.ok to be false in the EdgeWorker,
    // preventing the error response from being written to the edge cache.
    if !(200..300).contains(&(*status as u16)) {
        return Ok(Response::builder()
            .status(502)
            .body(format!("Origin returned non-2xx status: {}", status))
            .build());
    }

    // HTML may contain non-UTF-8 bytes; lossy conversion preserves structure
    // and avoids panicking on malformed pages.
    let html_string = String::from_utf8_lossy(origin_resp.body()).to_string();

    // 3. Strip non-semantic tags before conversion. Beyond CSS/JS (style/script/
    //    noscript), site chrome (nav/header/footer/aside) and embeds (svg/iframe/
    //    form) convert into large blocks of Markdown noise — they bloat the output
    //    and add zero value for AI crawlers. (On heavy pages this is the difference
    //    between multi-MB and lean Markdown.) Mirrors the demo's Turndown strip set.
    let mut cleaned = html_string;
    for tag in ["style", "script", "noscript", "nav", "header", "footer", "aside", "svg", "iframe", "form"] {
        cleaned = strip_tag_blocks(&cleaned, tag);
    }

    // 4. Transform heavy HTML into clean Markdown on the fly
    let markdown_payload = parse_html(&cleaned);

    // 5. Write-through to Harper (opt-in; never fatal). This is the write the
    //    EdgeWorker cannot perform at the edge.
    let harper_write = write_to_harper(&req, &markdown_payload).await;

    // 6. Return the payload to the EdgeWorker
    Ok(Response::builder()
        .status(200)
        .header("content-type", "text/markdown")
        .header("x-wasm-execution", "success")
        .header("x-harper-write", harper_write)
        .body(markdown_payload)
        .build())
}
