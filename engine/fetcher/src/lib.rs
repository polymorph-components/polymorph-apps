//! The fetch component: a buffered HTTP client over `wasip3`'s async
//! `wasi:http/client@0.3` (`http_compat` bridging to the `http` crate
//! types). Exists as its own component so the wasip3 crate's wit-bindgen
//! 0.57 runtime never shares a component with the storage guest's 0.59
//! runtime — and so the network capability is a separate, pluggable seam.

mod bindings {
    wit_bindgen::generate!({
        path: "wit",
        world: "fetcher",
    });
}

use bindings::exports::polyvisor::fetch::fetch::{Guest, Response};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};

struct Component;

impl Guest for Component {
    async fn request(
        method: String,
        url: String,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    ) -> Result<Response, String> {
        let mut builder = http::Request::builder()
            .method(method.as_str())
            .uri(url.as_str());
        for (name, value) in &headers {
            builder = builder.header(name.as_str(), value.as_str());
        }
        // Some S3 endpoints (e.g. MinIO's PutBucketPolicy) require an
        // explicit Content-Length; the buffered body's length is exact.
        builder = builder.header("content-length", body.len().to_string());
        let request = builder
            .body(Full::new(Bytes::from(body)))
            .map_err(|e| format!("build request: {e}"))?;

        let wasi_request = wasip3::http_compat::http_into_wasi_request(request)
            .map_err(|e| format!("into wasi request: {e:?}"))?;
        let wasi_response = wasip3::http::client::send(wasi_request)
            .await
            .map_err(|e| format!("send: {e:?}"))?;
        let response = wasip3::http_compat::http_from_wasi_response(wasi_response)
            .map_err(|e| format!("from wasi response: {e:?}"))?;

        let status = response.status().as_u16();
        let collected = response
            .into_body()
            .collect()
            .await
            .map_err(|e| format!("collect body: {e:?}"))?;
        Ok(Response {
            status,
            body: collected.to_bytes().to_vec(),
        })
    }
}

bindings::export!(Component with_types_in bindings);
