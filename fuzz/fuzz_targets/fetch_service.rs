#![no_main]

use std::cell::RefCell;
use std::sync::{Arc, Mutex};

use libfuzzer_sys::fuzz_target;
use serde::Deserialize;

use fetchlet::{Body, FetchPolicy, FetchService, Limits, Request, http, transport_fn};

thread_local! {
    static RUNTIME: RefCell<tokio::runtime::Runtime> = RefCell::new(
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
    );
}

#[derive(Deserialize)]
struct RequestCase {
    url: String,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    rewrite: Option<String>,
    #[serde(default)]
    redirects: Vec<String>,
    #[serde(default)]
    headers: Vec<(String, String)>,
    #[serde(default)]
    body: Vec<u8>,
}

fn build_request(input: &RequestCase) -> Option<Request> {
    let method = input.method.as_deref().unwrap_or("GET");
    let mut builder = http::Request::builder().uri(&input.url).method(method);

    for (name, value) in &input.headers {
        builder = builder.header(name, value);
    }

    builder.body(Body::from(input.body.clone())).ok()
}

fuzz_target!(|data: &[u8]| {
    if data.len() > 64 * 1024 {
        return;
    }

    let Ok(input) = serde_json::from_slice::<RequestCase>(data) else {
        return;
    };
    let Some(request) = build_request(&input) else {
        return;
    };

    let sent_requests = Arc::new(Mutex::new(Vec::new()));
    let captured_requests = sent_requests.clone();
    let redirect_locations = input.redirects;

    let transport = transport_fn(move |request| {
        let mut captured = captured_requests.lock().unwrap();
        let hop = captured.len();
        captured.push(request);

        let mut response = http::Response::builder().status(200);
        if let Some(location) = redirect_locations.get(hop) {
            response = http::Response::builder()
                .status(302)
                .header("location", location);
        }

        async move {
            response
                .body(Body::empty())
                .map_err(|error| fetchlet::Error::Transport(error.to_string()))
        }
    });

    let policy = FetchPolicy::deny_all()
        .allow_origin("https://allowed.test")
        .unwrap();

    let mut service = FetchService::new(transport, policy);
    if let Some(rewritten_url) = input.rewrite {
        service = service.rewrite(move |request| {
            *request.uri_mut() = rewritten_url
                .parse()
                .map_err(|_| fetchlet::Error::InvalidRequest("invalid rewritten URI".into()))?;
            Ok(())
        });
    }

    let limits = Limits {
        request_body_bytes: Some(4096),
        header_bytes: Some(4096),
        redirects: Some(3),
        ..Limits::default()
    };

    RUNTIME.with(|runtime| {
        let _result = runtime
            .borrow_mut()
            .block_on(service.fetch(request, limits));
    });

    let sent_requests = sent_requests.lock().unwrap();
    assert!(sent_requests.len() <= 4);

    for request in sent_requests.iter() {
        for forbidden in ["CONNECT", "TRACE", "TRACK"] {
            assert!(!request.method().as_str().eq_ignore_ascii_case(forbidden));
        }
        let url = url::Url::parse(&request.uri().to_string()).unwrap();
        assert_eq!(url.origin().ascii_serialization(), "https://allowed.test");
        assert!(url.username().is_empty());
        assert!(url.password().is_none());
        assert!(!request.headers().contains_key("host"));
        assert!(!request.headers().contains_key("transfer-encoding"));
        assert!(!request.headers().contains_key("content-length"));
    }
});
