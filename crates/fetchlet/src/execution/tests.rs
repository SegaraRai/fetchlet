use std::time::Duration;

use super::WakeSignal;

#[tokio::test]
async fn notification_before_wait_is_retained() {
    let signal = WakeSignal::default();
    signal.waker().wake_by_ref();

    tokio::time::timeout(Duration::from_millis(100), signal.wait(None))
        .await
        .expect("stored notification should wake the engine");
}

#[tokio::test]
async fn future_completion_wakes_the_engine() {
    let signal = WakeSignal::default();
    let waker = signal.waker();

    let notification = async move {
        tokio::task::yield_now().await;
        waker.wake();
    };

    let waiting = async {
        tokio::time::timeout(Duration::from_millis(100), signal.wait(None))
            .await
            .expect("future notification should wake the engine");
    };

    tokio::join!(notification, waiting);
}

#[test]
fn caller_budgets_have_no_implementation_ceiling() {
    let limits = crate::Limits {
        timeout: Some(std::time::Duration::from_secs(7200)),
        request_body_bytes: Some(16 * 1024 * 1024),
        response_body_bytes: Some(16 * 1024 * 1024),
        header_bytes: Some(1024 * 1024),
        bridge_message_bytes: Some(32 * 1024 * 1024),
        subrequests: Some(4096),
        ..crate::Limits::default()
    };

    assert!(limits.validate().is_ok());
    assert!(crate::Limits::default().timeout.is_none());
}
