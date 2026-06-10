use spin_sdk::http::{IntoResponse, Request, Response, send};
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

    // 3. Strip non-semantic tags before conversion — style/script/noscript blocks
    //    contain CSS and JS that html2md converts to noise, not content.
    let mut cleaned = strip_tag_blocks(&html_string, "style");
    cleaned = strip_tag_blocks(&cleaned, "script");
    cleaned = strip_tag_blocks(&cleaned, "noscript");

    // 4. Transform heavy HTML into clean Markdown on the fly
    let markdown_payload = parse_html(&cleaned);

    // 4. Return the payload to the EdgeWorker to be cached at the Edge
    Ok(Response::builder()
        .status(200)
        .header("content-type", "text/markdown")
        .header("x-wasm-execution", "success")
        .body(markdown_payload)
        .build())
}