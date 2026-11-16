use std::future::pending;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{Value, json};

use super::HostBridge;
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
    assert_eq!(
        completions[0]["result"]["value"]["body"],
        json!([104, 101, 108, 108, 111])
    );
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
