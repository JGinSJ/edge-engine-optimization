use spin_sdk::http::{IntoResponse, Request, Response, send};
use spin_sdk::http_component;
use html2md::parse_html;

#[http_component]
async fn handle_ai_markdown(req: Request) -> anyhow::Result<impl IntoResponse> {
    let target_url = match req.header("X-Target-URL") {
        Some(url) => String::from_utf8_lossy(url.as_bytes()).to_string(),
        None => return Ok(Response::builder()
            .status(400)
            .body("Missing X-Target-URL header from EdgeWorker")
            .build()),
    };

    let origin_req = Request::get(&target_url);
    let origin_resp: Response = send(origin_req).await.map_err(|e| anyhow::anyhow!("Request failed: {:?}", e))?;

    let status = origin_resp.status();
    // Returning 502 causes wasmResponse.ok to be false in the EdgeWorker,
    // preventing the error response from being written to the edge cache.
    if !(200..300).contains(&(status as u16)) {
        return Ok(Response::builder()
            .status(502)
            .body(format!("Origin returned non-2xx status: {}", status))
            .build());
    }

    // HTML may contain non-UTF-8 bytes; lossy conversion preserves structure
    // and avoids panicking on malformed pages.
    let html_string = String::from_utf8_lossy(origin_resp.body()).to_string();

    let markdown_payload = parse_html(&html_string);

    Ok(Response::builder()
        .status(200)
        .header("content-type", "text/markdown")
        .header("x-wasm-execution", "success")
        .body(markdown_payload)
        .build())
}