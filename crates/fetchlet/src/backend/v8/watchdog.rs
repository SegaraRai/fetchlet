//! A thread that terminates a V8 isolate whose [`Interrupt`] expires. V8
//! runs JavaScript without asking the embedder, so another thread has to
//! check the busy timeout and the startup deadline while it runs.

use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use deno_core::v8;

use crate::execution::Interrupt;

/// The isolate a watchdog terminates, set once the worker has created it.
pub(super) type IsolateSlot = Arc<OnceLock<v8::IsolateHandle>>;

/// The finest and coarsest checks: a stop lands within the timeout plus
/// one interval, and an idle instance wakes its watchdog at most every
/// 100 ms.
const FINEST: Duration = Duration::from_millis(1);
const COARSEST: Duration = Duration::from_millis(100);

pub(super) struct Watchdog {
    stop: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl Watchdog {
    /// Watch `interrupt` when there is a timeout only another thread can
    /// enforce, the busy timeout or the startup deadline; `None` otherwise.
    /// It checks four times per shortest timeout, within [`FINEST`] and
    /// [`COARSEST`].
    pub fn start(
        interrupt: &Interrupt,
        startup_timeout: Option<Duration>,
        isolate: &IsolateSlot,
    ) -> std::io::Result<Option<Self>> {
        let shortest = match (interrupt.busy_timeout(), startup_timeout) {
            (Some(busy), Some(startup)) => busy.min(startup),
            (Some(timeout), None) | (None, Some(timeout)) => timeout,
            (None, None) => return Ok(None),
        };
        let interval = (shortest / 4).clamp(FINEST, COARSEST);
        let (stop, stopped) = mpsc::channel::<()>();
        let interrupt = interrupt.clone();
        let isolate = isolate.clone();
        let thread = thread::Builder::new()
            .name("fetchlet-v8-watchdog".into())
            .spawn(move || {
                while let Err(RecvTimeoutError::Timeout) = stopped.recv_timeout(interval) {
                    if interrupt.expired()
                        && let Some(isolate) = isolate.get()
                    {
                        isolate.terminate_execution();
                    }
                }
            })?;
        Ok(Some(Self {
            stop: Some(stop),
            thread: Some(thread),
        }))
    }
}

impl Drop for Watchdog {
    fn drop(&mut self) {
        // Closing the channel ends the thread's wait at once.
        drop(self.stop.take());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
