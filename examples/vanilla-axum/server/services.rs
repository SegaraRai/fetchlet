use std::time::Duration;

use fetchlet::{
    Body, ChannelRequest, CloseFrame, Error, FetchPolicy, FetchService, HostServices, Message,
    Response, Result, channel_fn, http, transport_fn,
};
use serde::Deserialize;

/// Steps one progress channel reports at most: the example's own bound on
/// work a request can ask of the host.
const MAX_STEPS: u32 = 20;

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
        .service("RUST", service)?
        .channel("PROGRESS", channel_fn(progress))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProgressOptions {
    steps: u32,
    /// Send lines as binary messages, for the channel's stream view.
    #[serde(default)]
    bytes: bool,
}

/// A channel that reports the steps of a Rust job, one message each, then
/// closes. The job runs on the host runtime and stops when JavaScript's end
/// goes away.
async fn progress(request: ChannelRequest) -> Result<()> {
    let options: ProgressOptions = serde_json::from_value(request.options)
        .map_err(|_| Error::InvalidRequest("invalid progress options".into()))?;
    if options.steps > MAX_STEPS {
        return Err(Error::LimitExceeded("progress steps"));
    }
    let mut end = request.end;
    tokio::spawn(async move {
        for step in 1..=options.steps {
            tokio::time::sleep(Duration::from_millis(10)).await;
            let line = format!("step {step} of {}\n", options.steps);
            let message = if options.bytes {
                Message::Binary(line.into_bytes().into())
            } else {
                Message::Text(line)
            };
            if end.send(message).await.is_err() {
                return;
            }
        }
        end.close(CloseFrame::new(CloseFrame::NORMAL, "done"));
    });
    Ok(())
}
