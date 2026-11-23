use std::future::pending;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{Value, json};

use super::HostBridge;
use super::dispatcher::Whole;
use crate::host::{FetchPolicy, FetchService, transport_fn};
use crate::{Body, Error, HostServices, Limits, Response};

struct DropCounter(Arc<AtomicUsize>);

impl Drop for DropCounter {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

fn start_request() -> String {
    json!({
        "service": null,
        "redirect": "follow",
        "request": {
            "url": "https://allowed.test/",
            "method": "GET",
            "headers": [],
            "body": null,
        },
    })
    .to_string()
}

fn pending_bridge(dropped: Arc<AtomicUsize>) -> HostBridge {
    let transport = transport_fn(move |_| {
        let guard = DropCounter(dropped.clone());

        async move {
            let _guard = guard;
            pending::<()>().await;
            Ok(Response::new(Body::empty()))
        }
    });

    let policy = FetchPolicy::deny_all()
        .allow_origin("https://allowed.test")
        .unwrap();
    let service = FetchService::new(transport, policy);

    HostBridge::new(HostServices::new().outbound(service))
}

#[test]
fn default_services_deny_fetch() {
    let bridge = HostBridge::default();
    let _scope = bridge.begin(Limits::default()).unwrap();

    assert!(matches!(
        bridge.start_fetch(&start_request()),
        Err(Error::PermissionDenied)
    ));
}

#[test]
fn native_protocol_reports_unknown_operations_as_permission_errors() {
    let bridge = HostBridge::default();
    let reply = bridge.dispatch("filesystem.read".into(), "{}".into());
    let reply: Value = serde_json::from_str(&reply).unwrap();

    assert_eq!(reply["ok"], false);
    assert_eq!(reply["error"]["code"], "PERMISSION_DENIED");
}

#[test]
fn host_operations_require_an_active_invocation() {
    let bridge = HostBridge::default();

    assert!(matches!(
        bridge.start_fetch(&start_request()),
        Err(Error::InvocationClosed)
    ));
    assert!(matches!(
        bridge.poll_fetches(),
        Err(Error::InvocationClosed)
    ));

    let scope = bridge.begin(Limits::default()).unwrap();
    assert!(bridge.begin(Limits::default()).is_err());
    drop(scope);

    assert!(bridge.begin(Limits::default()).is_ok());
}

#[test]
fn dropping_an_invocation_drops_started_transport_futures() {
    let dropped = Arc::new(AtomicUsize::new(0));
    let bridge = pending_bridge(dropped.clone());
    let scope = bridge.begin(Limits::default()).unwrap();

    bridge.start_fetch(&start_request()).unwrap();
    assert_eq!(bridge.poll_fetches().unwrap(), json!([]));
    assert!(scope.has_pending());
    assert_eq!(dropped.load(Ordering::SeqCst), 0);

    drop(scope);

    assert_eq!(dropped.load(Ordering::SeqCst), 1);
    assert!(matches!(
        bridge.poll_fetches(),
        Err(Error::InvocationClosed)
    ));
}

#[test]
fn cancellation_is_immediate_and_tickets_do_not_cross_invocations() {
    let dropped = Arc::new(AtomicUsize::new(0));
    let bridge = pending_bridge(dropped.clone());
    let first_scope = bridge.begin(Limits::default()).unwrap();

    let first_ticket = bridge.start_fetch(&start_request()).unwrap();
    bridge.poll_fetches().unwrap();
    bridge.cancel_fetch(&first_ticket.to_string()).unwrap();

    assert_eq!(dropped.load(Ordering::SeqCst), 1);
    assert!(!first_scope.has_pending());
    drop(first_scope);

    let second_scope = bridge.begin(Limits::default()).unwrap();
    let second_ticket = bridge.start_fetch(&start_request()).unwrap();
    bridge.poll_fetches().unwrap();

    assert_ne!(first_ticket, second_ticket);
    assert!(matches!(
        bridge.cancel_fetch(&first_ticket.to_string()),
        Err(Error::InvocationClosed)
    ));
    assert!(second_scope.has_pending());
    assert_eq!(dropped.load(Ordering::SeqCst), 1);

    drop(second_scope);
    assert_eq!(dropped.load(Ordering::SeqCst), 2);
}

#[test]
fn subrequest_budget_is_not_replenished_by_cancellation() {
    let bridge = pending_bridge(Arc::new(AtomicUsize::new(0)));
    let limits = Limits {
        subrequests: Some(1),
        ..Limits::default()
    };
    let _scope = bridge.begin(limits).unwrap();

    let ticket = bridge.start_fetch(&start_request()).unwrap();
    bridge.cancel_fetch(&ticket.to_string()).unwrap();

    assert!(matches!(
        bridge.start_fetch(&start_request()),
        Err(Error::LimitExceeded("subrequests"))
    ));
}

#[test]
fn malformed_and_oversized_messages_are_rejected() {
    let bridge = pending_bridge(Arc::new(AtomicUsize::new(0)));
    let _scope = bridge
        .begin(Limits {
            bridge_message_bytes: Some(32),
            ..Limits::default()
        })
        .unwrap();

    for input in ["null", "{}", "[]", "{", r#"{"request":null}"#] {
        assert!(bridge.start_fetch(input).is_err());
    }

    let oversized = " ".repeat(33);
    assert!(matches!(
        bridge.dispatch_operation("fetch.start", &oversized),
        Err(Error::LimitExceeded("bridge message bytes"))
    ));
}

#[test]
fn completion_is_delivered_once_and_releases_the_scope() {
    let policy = FetchPolicy::deny_all()
        .allow_origin("https://allowed.test")
        .unwrap();
    let service = FetchService::new(
        transport_fn(|_| async { Ok(Response::new(Body::from("hello"))) }),
        policy,
    );
    let bridge = HostBridge::new(HostServices::new().outbound(service));
    let scope = bridge.begin(Limits::default()).unwrap();

    let ticket = bridge.start_fetch(&start_request()).unwrap();
    let completions = bridge.poll_fetches().unwrap();

    assert_eq!(completions[0]["id"], ticket);
    assert_eq!(completions[0]["result"]["ok"], true);
    // The body crosses as a byte-store handle, not a JSON array.
    let handle = completions[0]["result"]["value"]["body"].as_f64().unwrap();
    assert_eq!(&bridge.take_guest_bytes(handle).unwrap()[..], b"hello");
    assert_eq!(bridge.poll_fetches().unwrap(), json!([]));
    assert!(!scope.has_pending());
}

#[test]
fn provider_error_details_are_not_exposed_to_javascript() {
    let policy = FetchPolicy::deny_all()
        .allow_origin("https://allowed.test")
        .unwrap();
    let service = FetchService::new(
        transport_fn(|_| async {
            Err(Error::Transport(
                "private diagnostic with secret-marker".into(),
            ))
        }),
        policy,
    );
    let bridge = HostBridge::new(HostServices::new().outbound(service));
    let _scope = bridge.begin(Limits::default()).unwrap();

    bridge.start_fetch(&start_request()).unwrap();
    let completions = bridge.poll_fetches().unwrap();

    assert_eq!(completions[0]["result"]["error"]["code"], "TRANSPORT");
    assert!(!completions.to_string().contains("secret-marker"));
}

#[tokio::test]
async fn a_pending_transport_future_notifies_the_engine_when_ready() {
    let (sender, receiver) = tokio::sync::oneshot::channel::<()>();
    let receiver = Arc::new(std::sync::Mutex::new(Some(receiver)));
    let service = FetchService::new(
        transport_fn(move |_| {
            let receiver = receiver.lock().unwrap().take().unwrap();
            async move {
                receiver.await.unwrap();
                Ok(Response::new(Body::from("ready")))
            }
        }),
        FetchPolicy::deny_all()
            .allow_origin("https://allowed.test")
            .unwrap(),
    );
    let bridge = HostBridge::new(HostServices::new().outbound(service));
    let _scope = bridge.begin(Limits::default()).unwrap();

    bridge.start_fetch(&start_request()).unwrap();
    assert_eq!(bridge.poll_fetches().unwrap(), json!([]));
    sender.send(()).unwrap();

    tokio::time::timeout(
        std::time::Duration::from_millis(100),
        bridge.wake_signal().wait(None),
    )
    .await
    .expect("transport completion should wake the engine");
    let replies = bridge.poll_fetches().unwrap();
    assert_eq!(replies[0]["result"]["ok"], true);
}

#[test]
fn performance_clock_has_a_stable_origin_and_monotonic_elapsed_time() {
    let bridge = HostBridge::default();
    let first = bridge.dispatch_operation("clock", "null").unwrap();
    let second = bridge.dispatch_operation("clock", "null").unwrap();
    let origin = first["timeOrigin"].as_f64().unwrap();
    let initial = first["now"].as_f64().unwrap();
    let following = second["now"].as_f64().unwrap();
    assert!(origin.is_finite());
    assert!(initial.is_finite() && initial >= 0.0);
    assert!(following.is_finite() && following >= initial);
    assert_eq!(second["timeOrigin"], first["timeOrigin"]);
}

#[test]
fn guest_byte_handles_are_scoped_to_their_invocation() {
    let bridge = HostBridge::default();
    let scope = bridge.begin(Limits::default()).unwrap();
    let handle = bridge.put_guest_bytes(b"abc").unwrap();
    assert_eq!(&bridge.take_guest_bytes(handle as f64).unwrap()[..], b"abc");
    let stale = bridge.put_guest_bytes(b"left behind").unwrap();
    // A handle is taken once.
    assert!(matches!(
        bridge.take_guest_bytes(handle as f64),
        Err(Error::InvalidRequest(_))
    ));
    // Numbers that cannot be handles are rejected before lookup.
    for invalid in [
        0.0,
        -1.0,
        1.5,
        f64::NAN,
        f64::INFINITY,
        9_007_199_254_740_992.0,
    ] {
        assert!(matches!(
            bridge.take_guest_bytes(invalid),
            Err(Error::InvalidRequest(_))
        ));
    }
    drop(scope);

    // Bytes left in an ended invocation are unreachable from the next one.
    assert!(matches!(
        bridge.take_guest_bytes(stale as f64),
        Err(Error::InvocationClosed)
    ));
    let _scope = bridge.begin(Limits::default()).unwrap();
    assert!(matches!(
        bridge.take_guest_bytes(stale as f64),
        Err(Error::InvalidRequest(_))
    ));
}

#[test]
fn guest_byte_buffers_count_as_bridge_messages() {
    let bridge = HostBridge::default();
    let limits = Limits {
        bridge_message_bytes: Some(4),
        ..Limits::default()
    };
    let _scope = bridge.begin(limits).unwrap();

    assert!(bridge.put_guest_bytes(b"four").is_ok());
    assert!(matches!(
        bridge.put_guest_bytes(b"five!"),
        Err(Error::LimitExceeded(_))
    ));
}

fn read_completion(bridge: &HostBridge, ticket: &Value) -> Option<Value> {
    let completions = bridge.poll_fetches().unwrap();
    let completion = completions.as_array().unwrap().first()?.clone();
    assert_eq!(&completion["id"], ticket);
    Some(completion["result"].clone())
}

#[test]
fn body_sources_are_read_one_chunk_at_a_time_and_released() {
    let bridge = HostBridge::default();
    let scope = bridge.begin(Limits::default()).unwrap();
    let (sender, body) = Body::channel(bytes::Bytes::new(), 1);
    let id = bridge.open_body(body, None, "request body bytes").unwrap();

    let ticket = bridge.read_body(&id.to_string(), None).unwrap();
    // A second read of the same body waits for the first.
    assert!(matches!(
        bridge.read_body(&id.to_string(), None),
        Err(Error::InvalidRequest(_))
    ));
    assert_eq!(read_completion(&bridge, &ticket), None);

    sender.try_send(Ok(("abc".into(), false))).unwrap();
    let result = read_completion(&bridge, &ticket).unwrap();
    assert_eq!(result["value"]["done"], false);
    let handle = result["value"]["chunk"].as_f64().unwrap();
    assert_eq!(&bridge.take_guest_bytes(handle).unwrap()[..], b"abc");

    sender.try_send(Ok(("".into(), true))).unwrap();
    let ticket = bridge.read_body(&id.to_string(), None).unwrap();
    let result = read_completion(&bridge, &ticket).unwrap();
    assert_eq!(result["value"], json!({ "chunk": null, "done": true }));
    // A finished body is gone.
    assert!(matches!(
        bridge.read_body(&id.to_string(), None),
        Err(Error::InvalidRequest(_))
    ));
    drop(scope);

    // Ids name bodies of the current invocation only.
    let _scope = bridge.begin(Limits::default()).unwrap();
    assert!(matches!(
        bridge.read_body(&id.to_string(), None),
        Err(Error::InvalidRequest(_))
    ));
}

#[test]
fn handles_name_one_kind_in_one_invocation() {
    let bridge = HostBridge::default();
    let scope = bridge.begin(Limits::default()).unwrap();
    let (sender, body) = Body::channel(bytes::Bytes::new(), 1);
    let body = bridge.open_body(body, None, "request body bytes").unwrap();
    bridge.allow_upgrade().unwrap();
    let channel = bridge
        .dispatch_operation("websocket.upgrade", "null")
        .unwrap()
        .as_u64()
        .unwrap();
    let _end = bridge.take_upgrade(channel).unwrap();
    assert_ne!(body, channel);

    // A body's handle is not a channel's, nor the other way round.
    assert!(matches!(
        bridge.dispatch_operation("channel.buffered", &body.to_string()),
        Err(Error::InvalidRequest(_))
    ));
    assert!(matches!(
        bridge.read_body(&channel.to_string(), None),
        Err(Error::InvalidRequest(_))
    ));
    // Cancelling a channel's handle as a body releases nothing.
    bridge.cancel_body(&channel.to_string()).unwrap();
    assert_eq!(
        bridge
            .dispatch_operation("channel.buffered", &channel.to_string())
            .unwrap(),
        json!(0)
    );

    // A released body's handle stays stale when its slot is reused.
    bridge.cancel_body(&body.to_string()).unwrap();
    assert!(sender.is_closed());
    let (_sender, again) = Body::channel(bytes::Bytes::new(), 1);
    let again = bridge.open_body(again, None, "request body bytes").unwrap();
    assert_ne!(again, body);
    assert!(matches!(
        bridge.read_body(&body.to_string(), None),
        Err(Error::InvalidRequest(_))
    ));
    drop(scope);

    // Nothing of an earlier invocation resolves in the next one.
    let _scope = bridge.begin(Limits::default()).unwrap();
    let (_sender, next) = Body::channel(bytes::Bytes::new(), 1);
    let next = bridge.open_body(next, None, "request body bytes").unwrap();
    for stale in [body, again, channel] {
        assert_ne!(stale, next);
        assert!(matches!(
            bridge.read_body(&stale.to_string(), None),
            Err(Error::InvalidRequest(_))
        ));
    }
    assert!(matches!(
        bridge.dispatch_operation("channel.buffered", &channel.to_string()),
        Err(Error::InvalidRequest(_))
    ));
}

#[test]
fn cancelling_a_body_source_drops_its_producer() {
    let bridge = HostBridge::default();
    let _scope = bridge.begin(Limits::default()).unwrap();
    let (sender, body) = Body::channel(bytes::Bytes::new(), 1);
    let id = bridge.open_body(body, None, "request body bytes").unwrap();
    let ticket = bridge.read_body(&id.to_string(), None).unwrap();
    assert_eq!(read_completion(&bridge, &ticket), None);

    bridge.cancel_body(&id.to_string()).unwrap();
    assert!(sender.is_closed());
    // The cancelled read never completes, and cancelling again is harmless.
    assert_eq!(bridge.poll_fetches().unwrap(), json!([]));
    bridge.cancel_body(&id.to_string()).unwrap();
}

#[test]
fn body_sources_apply_their_budget_to_bytes_read() {
    let bridge = HostBridge::default();
    let _scope = bridge.begin(Limits::default()).unwrap();
    let (sender, body) = Body::channel(bytes::Bytes::new(), 2);
    let id = bridge
        .open_body(body, Some(4), "request body bytes")
        .unwrap();
    sender.try_send(Ok(("abc".into(), false))).unwrap();
    sender.try_send(Ok(("de".into(), false))).unwrap();

    let ticket = bridge.read_body(&id.to_string(), None).unwrap();
    assert_eq!(read_completion(&bridge, &ticket).unwrap()["ok"], true);
    let ticket = bridge.read_body(&id.to_string(), None).unwrap();
    let result = read_completion(&bridge, &ticket).unwrap();
    assert_eq!(result["error"]["code"], "LIMIT_EXCEEDED");
    // The failed body released its producer.
    assert!(sender.is_closed());
}

#[test]
fn a_whole_body_read_collects_the_rest_in_one_buffer() {
    let bridge = HostBridge::default();
    let _scope = bridge.begin(Limits::default()).unwrap();
    let (sender, body) = Body::channel(bytes::Bytes::new(), 1);
    let id = bridge.open_body(body, None, "response body bytes").unwrap();

    let ticket = bridge
        .read_body(&id.to_string(), Some(Whole::Bytes))
        .unwrap();
    // The whole read is the body's one read in flight.
    assert!(matches!(
        bridge.read_body(&id.to_string(), None),
        Err(Error::InvalidRequest(_))
    ));
    // Chunks wait in Rust until the body ends.
    sender.try_send(Ok(("abc".into(), false))).unwrap();
    assert_eq!(read_completion(&bridge, &ticket), None);
    sender.try_send(Ok(("de".into(), true))).unwrap();
    let result = read_completion(&bridge, &ticket).unwrap();
    assert_eq!(result["value"]["done"], true);
    let handle = result["value"]["chunk"].as_f64().unwrap();
    assert_eq!(&bridge.take_guest_bytes(handle).unwrap()[..], b"abcde");
    // The finished body is gone.
    assert!(matches!(
        bridge.read_body(&id.to_string(), Some(Whole::Bytes)),
        Err(Error::InvalidRequest(_))
    ));

    // An empty body reads as an empty buffer.
    let id = bridge
        .open_body(Body::empty(), None, "response body bytes")
        .unwrap();
    let ticket = bridge
        .read_body(&id.to_string(), Some(Whole::Bytes))
        .unwrap();
    let result = read_completion(&bridge, &ticket).unwrap();
    let handle = result["value"]["chunk"].as_f64().unwrap();
    assert!(bridge.take_guest_bytes(handle).unwrap().is_empty());
}

#[test]
fn a_whole_body_read_as_text_decodes_as_fetch_does() {
    let bridge = HostBridge::default();
    let _scope = bridge.begin(Limits::default()).unwrap();
    let (sender, body) = Body::channel(bytes::Bytes::new(), 2);
    let id = bridge.open_body(body, None, "response body bytes").unwrap();
    // The byte order mark goes, and a sequence split across chunks decodes
    // once the body is whole; invalid bytes become U+FFFD.
    sender
        .try_send(Ok((b"\xEF\xBB\xBFcaf\xC3"[..].into(), false)))
        .unwrap();
    sender
        .try_send(Ok((b"\xA9 \xFF\xEF\xBB\xBF"[..].into(), true)))
        .unwrap();
    let ticket = bridge
        .read_body(&id.to_string(), Some(Whole::Text))
        .unwrap();
    let result = read_completion(&bridge, &ticket).unwrap();
    assert_eq!(
        result["value"],
        json!({ "text": "caf\u{e9} \u{fffd}\u{feff}", "done": true })
    );
}

#[test]
fn a_whole_body_read_keeps_the_budget_and_releases_on_cancel() {
    let bridge = HostBridge::default();
    let _scope = bridge.begin(Limits::default()).unwrap();
    let (sender, body) = Body::channel(bytes::Bytes::new(), 2);
    let id = bridge
        .open_body(body, Some(4), "response body bytes")
        .unwrap();
    sender.try_send(Ok(("abc".into(), false))).unwrap();
    sender.try_send(Ok(("de".into(), false))).unwrap();
    let ticket = bridge
        .read_body(&id.to_string(), Some(Whole::Bytes))
        .unwrap();
    let result = read_completion(&bridge, &ticket).unwrap();
    assert_eq!(result["error"]["code"], "LIMIT_EXCEEDED");
    assert!(sender.is_closed());

    // Cancelling drops the producer and the chunks collected so far.
    let (sender, body) = Body::channel(bytes::Bytes::new(), 1);
    let id = bridge.open_body(body, None, "response body bytes").unwrap();
    bridge
        .read_body(&id.to_string(), Some(Whole::Bytes))
        .unwrap();
    sender.try_send(Ok(("abc".into(), false))).unwrap();
    assert_eq!(bridge.poll_fetches().unwrap(), json!([]));
    bridge.cancel_body(&id.to_string()).unwrap();
    assert!(sender.is_closed());
    assert_eq!(bridge.poll_fetches().unwrap(), json!([]));
}

#[test]
fn an_untaken_guest_buffer_is_dropped_by_the_next_one() {
    let bridge = HostBridge::default();
    let _scope = bridge.begin(Limits::default()).unwrap();
    let first = bridge.put_guest_bytes(b"first").unwrap();
    let second = bridge.put_guest_bytes(b"second").unwrap();

    assert!(matches!(
        bridge.take_guest_bytes(first as f64),
        Err(Error::InvalidRequest(_))
    ));
    assert_eq!(
        &bridge.take_guest_bytes(second as f64).unwrap()[..],
        b"second"
    );
}

#[test]
fn background_work_is_counted_per_invocation_within_its_budget() {
    let bridge = HostBridge::default();
    let limits = Limits {
        background_tasks: Some(2),
        ..Limits::default()
    };
    assert!(matches!(
        bridge.register_background(),
        Err(Error::InvocationClosed)
    ));

    let scope = bridge.begin(limits.clone()).unwrap();
    assert!(!scope.has_background());
    bridge.register_background().unwrap();
    bridge.register_background().unwrap();
    // The budget counts registrations, settled or not.
    bridge.settle_background().unwrap();
    assert!(matches!(
        bridge.register_background(),
        Err(Error::LimitExceeded("background tasks"))
    ));
    assert!(scope.has_background());
    bridge.settle_background().unwrap();
    assert!(!scope.has_background());
    drop(scope);

    // A new invocation starts with its own count.
    let scope = bridge.begin(limits).unwrap();
    bridge.register_background().unwrap();
    assert!(scope.has_background());
}

fn function_bridge() -> HostBridge {
    let functions = crate::Functions::new()
        .method("later", |_| async { Ok(json!("later")) })
        .sync_method("now", |_| Ok(json!("now")));
    HostBridge::new(HostServices::new().functions("FN", functions).unwrap())
}

fn function_call(method: &str) -> String {
    json!({ "binding": "FN", "method": method, "args": [] }).to_string()
}

#[test]
fn function_calls_reach_only_bound_methods_of_their_kind() {
    let bridge = function_bridge();
    let _scope = bridge.begin(Limits::default()).unwrap();
    let call = |operation: &str, method: &str| -> Value {
        serde_json::from_str(&bridge.dispatch(operation.into(), function_call(method))).unwrap()
    };

    assert_eq!(
        call("function.call", "now"),
        json!({ "ok": true, "value": { "ok": true, "value": "now" } })
    );
    assert_eq!(
        call("function.call", "absent")["error"]["code"],
        "PERMISSION_DENIED"
    );
    // A sync method cannot start, nor an async method run at once.
    assert_eq!(
        call("function.start", "now")["error"]["code"],
        "INVALID_REQUEST"
    );
    assert_eq!(
        call("function.call", "later")["error"]["code"],
        "INVALID_REQUEST"
    );
    let unknown = json!({ "binding": "OTHER", "method": "now", "args": [] }).to_string();
    let reply: Value =
        serde_json::from_str(&bridge.dispatch("function.call".into(), unknown)).unwrap();
    assert_eq!(reply["error"]["code"], "PERMISSION_DENIED");
}

#[test]
fn an_async_call_completes_in_the_poll_and_keeps_the_invocation_pending() {
    let bridge = function_bridge();
    let scope = bridge.begin(Limits::default()).unwrap();
    let ticket = bridge
        .dispatch_operation("function.start", &function_call("later"))
        .unwrap();
    assert!(scope.has_pending());
    let completions = bridge.poll_fetches().unwrap();
    assert_eq!(
        completions,
        json!([{ "id": ticket, "result": { "ok": true, "value": "later" } }])
    );
    assert!(!scope.has_pending());
}

#[test]
fn function_calls_require_an_active_invocation() {
    let bridge = function_bridge();
    assert!(matches!(
        bridge.dispatch_operation("function.call", &function_call("now")),
        Err(Error::InvocationClosed)
    ));
}
