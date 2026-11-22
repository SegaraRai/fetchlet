use std::any::Any;
use std::future::Future;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;

use tokio::sync::{mpsc, oneshot, watch};

use super::lifecycle::WorkerStatus;
use super::protocol::Command;
use super::streaming::stream_response_body;
use super::{CancelledCalls, WorkerOptions};
use crate::{App, AppBuilder, Body, Error, Response, Result};

/// The worker threads of one [`AppHandle`](super::AppHandle), each owning one
/// instance, and the queue they share.
pub(super) struct Pool {
    builder: AppBuilder,
    options: WorkerOptions,
    /// The shared queue. A worker holds the lock only while it waits for the
    /// next command, so commands go to whichever worker is free.
    receiver: tokio::sync::Mutex<mpsc::Receiver<Command>>,
    shutdown: Arc<watch::Sender<bool>>,
    status: watch::Sender<WorkerStatus>,
    state: Mutex<PoolState>,
}

#[derive(Default)]
struct PoolState {
    /// Worker threads alive, including those still building their instance.
    workers: usize,
    /// Workers building their first instance.
    starting: usize,
    /// Workers waiting for a command.
    idle: usize,
    /// Idle workers above `min` that are exiting.
    retiring: usize,
    /// The first worker panic, reported as the pool's final state.
    failure: Option<String>,
    finished: bool,
}

impl Pool {
    /// Start the pool's `min` workers and wait until each has built its
    /// instance, so that a module that fails to initialize fails the spawn.
    pub async fn start(
        builder: AppBuilder,
        options: WorkerOptions,
        receiver: mpsc::Receiver<Command>,
        shutdown: Arc<watch::Sender<bool>>,
        status: watch::Sender<WorkerStatus>,
    ) -> Result<Arc<Self>> {
        let instances = options.instances;
        if instances.min > instances.max {
            return Err(Error::Configuration(
                "worker instances: min exceeds max".into(),
            ));
        }
        let pool = Arc::new(Self {
            builder,
            options,
            receiver: tokio::sync::Mutex::new(receiver),
            shutdown,
            status,
            state: Mutex::new(PoolState::default()),
        });
        // One build at a time: QuickJS seeds Math.random and its hash seed
        // from the time in microseconds, so contexts created at the same
        // moment on two threads would share both.
        let mut result = Ok(());
        for _ in 0..instances.min.get() {
            pool.lock_state().reserve_worker();
            let initialized = match pool.start_worker() {
                Ok(initialized) => initialized,
                Err(error) => {
                    let mut state = pool.lock_state();
                    state.starting -= 1;
                    state.workers -= 1;
                    result = Err(error);
                    break;
                }
            };
            result = match initialized.await {
                Ok(outcome) => outcome,
                // The worker panicked while it built its instance.
                Err(_) => Err(Error::WorkerClosed),
            };
            if result.is_err() {
                break;
            }
        }
        if let Err(error) = result {
            // Workers that did start stop once the handle drops the sender.
            pool.shutdown.send_replace(true);
            return Err(error);
        }
        Ok(pool)
    }

    /// Start another worker when the queue holds more commands than idle and
    /// starting workers can take and the pool is below `max`.
    pub fn grow(self: &Arc<Self>, queued: usize) {
        let mut state = self.lock_state();
        if state.finished
            || *self.shutdown.borrow()
            || state.workers - state.retiring >= self.options.instances.max.get()
            || queued <= state.idle + state.starting
        {
            return;
        }
        state.reserve_worker();
        drop(state);
        // A worker that fails to build exits; the queue keeps its commands
        // for the others.
        if self.start_worker().is_err() {
            let mut state = self.lock_state();
            state.starting -= 1;
            state.workers -= 1;
        }
    }

    fn lock_state(&self) -> MutexGuard<'_, PoolState> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// Spawn a worker counted by [`PoolState::reserve_worker`].
    fn start_worker(self: &Arc<Self>) -> Result<oneshot::Receiver<Result<()>>> {
        let (initialized, ready) = oneshot::channel();
        let mut thread = thread::Builder::new().name("fetchlet-app".into());
        if let Some(size) = self.options.stack_size_bytes {
            thread = thread.stack_size(size.get());
        }
        let pool = self.clone();
        thread
            .spawn(move || {
                let result = catch_unwind(AssertUnwindSafe(|| pool.run_worker(initialized)));
                let retired = match result {
                    Ok(retired) => retired,
                    Err(payload) => {
                        pool.fail(panic_message(payload));
                        false
                    }
                };
                pool.exit_worker(retired);
            })
            .map_err(|error| Error::WorkerFailed(error.to_string()))?;
        Ok(ready)
    }

    /// Returns whether the worker retired as idle.
    fn run_worker(self: &Arc<Self>, initialized: oneshot::Sender<Result<()>>) -> bool {
        let executor = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(executor) => executor,
            Err(error) => {
                self.lock_state().starting -= 1;
                let _ = initialized.send(Err(Error::WorkerFailed(error.to_string())));
                return false;
            }
        };
        let _entered = executor.enter();
        let built = self.builder.clone().build();
        self.lock_state().starting -= 1;
        let app = match built {
            Ok(app) => app,
            Err(error) => {
                let _ = initialized.send(Err(error));
                return false;
            }
        };
        let _ = initialized.send(Ok(()));
        executor.block_on(self.serve(app))
    }

    /// Take commands from the shared queue until it closes, or until this
    /// worker retires as idle, which it returns.
    async fn serve(self: &Arc<Self>, app: App) -> bool {
        let execution = Execution {
            response_body_queue: self.options.response_body_queue.get(),
            cancelled_calls: self.options.cancelled_calls,
        };
        let idle_timeout = self.options.instances.idle_timeout;
        let mut stopping = self.shutdown.subscribe();
        let mut draining = *stopping.borrow();
        if draining {
            // Shutdown began before this worker started: close the queue
            // itself, since it will not see the request as an event. A worker
            // holding the queue while it waits sees the request and lets go.
            self.receiver.lock().await.close();
        }
        let mut app = Some(app);
        loop {
            self.lock_state().idle += 1;
            let next = tokio::select! {
                command = async { self.receiver.lock().await.recv().await } => Next::Command(command),
                _ = stopping.wait_for(|requested| *requested), if !draining => Next::Shutdown,
                () = sleep(idle_timeout), if idle_timeout.is_some() => Next::Idle,
            };
            self.lock_state().idle -= 1;
            let command = match next {
                Next::Shutdown => {
                    // Accepted commands still run; no new ones arrive.
                    self.receiver.lock().await.close();
                    draining = true;
                    continue;
                }
                Next::Idle => {
                    if self.retire_idle() {
                        return true;
                    }
                    continue;
                }
                Next::Command(None) => return false,
                Next::Command(Some(command)) => command,
            };
            if command.is_cancelled() {
                continue;
            }
            let instance = match app.as_mut() {
                Some(instance) => instance,
                None => match self.builder.clone().build() {
                    Ok(instance) => app.insert(instance),
                    Err(error) => {
                        command.reject(error);
                        continue;
                    }
                },
            };
            command.execute(instance, execution).await;
            // Background work runs after the reply, before the next command.
            let _ = instance.finish_background().await;
            // A retired instance is replaced now, while other workers serve
            // the queue, rather than when the next command arrives. A build
            // that fails is retried, and reported, by the next command.
            if !instance.is_reusable() {
                app = self.builder.clone().build().ok();
            }
        }
    }

    /// Whether an idle worker above `min` may exit, reserving its exit so
    /// that workers timing out together leave `min` running.
    fn retire_idle(&self) -> bool {
        let mut state = self.lock_state();
        if state.workers - state.starting - state.retiring > self.options.instances.min.get() {
            state.retiring += 1;
            return true;
        }
        false
    }

    fn fail(&self, message: String) {
        self.lock_state().failure.get_or_insert(message);
        // The other workers finish what was accepted, then stop.
        self.shutdown.send_replace(true);
    }

    /// Count an exiting worker out. The last one closes the queue, so that
    /// commands left in it fail instead of waiting, and reports the final state.
    fn exit_worker(&self, retired: bool) {
        let mut state = self.lock_state();
        state.workers -= 1;
        if retired {
            state.retiring -= 1;
        }
        if state.workers > 0 || state.finished {
            return;
        }
        state.finished = true;
        let outcome = match state.failure.clone() {
            Some(message) => Err(message),
            None => Ok(()),
        };
        drop(state);
        if let Ok(mut receiver) = self.receiver.try_lock() {
            receiver.close();
            while receiver.try_recv().is_ok() {}
        }
        self.status.send_replace(WorkerStatus::Finished(outcome));
    }
}

impl PoolState {
    fn reserve_worker(&mut self) {
        self.workers += 1;
        self.starting += 1;
    }
}

enum Next {
    Command(Option<Command>),
    Shutdown,
    Idle,
}

async fn sleep(duration: Option<std::time::Duration>) {
    match duration {
        Some(duration) => tokio::time::sleep(duration).await,
        None => std::future::pending().await,
    }
}

/// How the worker runs each command.
#[derive(Clone, Copy)]
pub struct Execution {
    /// See [`WorkerOptions::response_body_queue`].
    pub response_body_queue: usize,
    pub cancelled_calls: CancelledCalls,
}

impl Command {
    pub fn is_cancelled(&self) -> bool {
        match self {
            Self::Call { reply, .. } => reply.is_closed(),
            Self::Fetch { reply, .. } => reply.is_closed(),
        }
    }

    pub fn reject(self, error: Error) {
        match self {
            Self::Call { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Self::Fetch { reply, .. } => {
                let _ = reply.send(Err(error));
            }
        }
    }

    /// Execute on the worker. A streaming Fetch response keeps the worker,
    /// and with it the instance, until its body finishes or is dropped.
    pub async fn execute(self, app: &mut App, execution: Execution) {
        let finish = execution.cancelled_calls == CancelledCalls::Finish;
        match self {
            Self::Call {
                export,
                arguments,
                reply,
            } => {
                complete(reply, app.call_json(&export, &arguments), finish).await;
            }
            Self::Fetch {
                request,
                context,
                mut reply,
            } => {
                let disconnect = app.disconnect();
                let head = if finish {
                    // The handler sees its request's signal abort when the
                    // caller leaves, and the closed reply fails the send
                    // below, which cancels an open body.
                    let head = app.fetch_head(*request, context, Some(disconnect.clone()));
                    tokio::pin!(head);
                    tokio::select! {
                        head = &mut head => head,
                        () = reply.closed() => {
                            disconnect.signal();
                            head.await
                        }
                    }
                } else {
                    tokio::select! {
                        head = app.fetch_head(*request, context, None) => head,
                        () = reply.closed() => return,
                    }
                };
                let (response, open) = match head {
                    Ok(head) => head,
                    Err(error) => {
                        let _ = reply.send(Err(error));
                        return;
                    }
                };
                let Some(open) = open else {
                    let _ = reply.send(Ok(response));
                    return;
                };
                let (parts, body) = response.into_parts();
                let prefix = match body.collect_within(None, "response body bytes").await {
                    Ok(prefix) => prefix,
                    Err(error) => {
                        app.cancel_response_body(open).await;
                        let _ = reply.send(Err(error));
                        return;
                    }
                };
                let (sender, body) = Body::channel(prefix, execution.response_body_queue);
                if reply.send(Ok(Response::from_parts(parts, body))).is_err() {
                    app.cancel_response_body(open).await;
                    return;
                }
                stream_response_body(app, open, sender, finish.then_some(disconnect)).await;
            }
        }
    }
}

async fn complete<T>(
    mut reply: oneshot::Sender<Result<T>>,
    execution: impl Future<Output = Result<T>>,
    finish: bool,
) {
    if finish {
        let _ = reply.send(execution.await);
        return;
    }
    tokio::select! {
        result = execution => {
            let _ = reply.send(result);
        }
        () = reply.closed() => {}
    }
}

fn panic_message(payload: Box<dyn Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<String>() {
        return message.clone();
    }
    if let Some(message) = payload.downcast_ref::<&str>() {
        return (*message).to_owned();
    }
    "Rust worker panicked".into()
}
