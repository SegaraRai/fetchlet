use fetchlet::{
    Body, FetchPolicy, FetchService, HostServices, Response, Result, http, transport_fn,
};

pub(crate) fn host_services(message: &str) -> Result<HostServices> {
    let policy = FetchPolicy::deny_all().allow_origin("https://fetchlet.internal")?;
    let service = FetchService::new(
        transport_fn(|_request| async {
            let body = serde_json::json!({ "message": "Greetings from the Rust service." });
            let mut response = Response::new(Body::from(body.to_string()));
            response.headers_mut().insert(
                "content-type",
                http::HeaderValue::from_static("application/json"),
            );
            Ok(response)
        }),
        policy,
    );

    HostServices::new()
        .env("MESSAGE", message)?
        .service("RUST", service)
}
