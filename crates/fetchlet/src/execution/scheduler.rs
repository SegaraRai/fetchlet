use std::sync::Arc;
use std::task::{Wake, Waker};
use std::time::Duration;

use tokio::sync::Notify;

/// Shared notification for the futures driven by one engine.
#[derive(Clone, Default)]
pub(crate) struct WakeSignal {
    notification: Arc<Notify>,
}

impl WakeSignal {
    pub fn notify(&self) {
        #[cfg(feature = "operation-counts")]
        crate::diagnostics::record("wake", 0, 0);
        self.notification.notify_one();
    }

    pub fn waker(&self) -> Waker {
        Waker::from(Arc::new(self.clone()))
    }

    #[cfg_attr(
        not(any(feature = "boa", feature = "quickjs", feature = "v8")),
        allow(dead_code)
    )]
    pub async fn wait(&self, timer_delay: Option<Duration>) {
        match timer_delay {
            Some(delay) => {
                tokio::select! {
                    () = self.notification.notified() => {}
                    () = tokio::time::sleep(delay) => {}
                }
            }
            None => self.notification.notified().await,
        }
    }
}

impl Wake for WakeSignal {
    fn wake(self: Arc<Self>) {
        self.notify();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        self.notify();
    }
}

#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
#[derive(serde::Deserialize)]
pub(crate) struct LoopState {
    pub progress: bool,
    delay: Option<u64>,
}

#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
impl LoopState {
    pub fn timer_delay(&self) -> Option<Duration> {
        self.delay.map(Duration::from_millis)
    }
}
