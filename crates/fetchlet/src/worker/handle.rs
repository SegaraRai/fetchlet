use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use tokio::sync::{Semaphore, mpsc, oneshot, watch};

use super::HeldConnection;
use super::lifecycle::{WorkerStatus, wait_for_shutdown};
use super::protocol::Command;
use crate::reentry::is_polling;
use crate::{Call, CallOutput, Error, Limits, Request, Response, Result};

#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
use {
    super::{PoolState, WorkerOptions, runtime},
    crate::AppBuilder,
    crate::reentry::new_key,
};

struct Shared {
    sender: mpsc::Sender<Command>,
    shutdown: Arc<watch::Sender<bool>>,
    status: watch::Receiver<WorkerStatus>,
    limits: Limits,
    /// The application identity, to refuse calls from its own host fetches.
    key: u64,
    /// Places for connections that hold an instance.
    held: Arc<Semaphore>,
    max_held: usize,
    /// Reservations refused because every place was taken.
    refused_connections: AtomicU64,
    /// The workers, which a queued command may ask to grow.
    #[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
    pool: Arc<runtime::Pool>,
}

/// A cloneable Send + Sync handle to one application on its worker threads.
///
/// Each instance executes one call at a time; [`WorkerOptions::instances`]
/// sets how many serve the queue. The configured queue applies backpressure
/// before accepting more work. Dropping a call future cancels that call; a
/// worker replaces a retired instance after the call that retired it.
#[derive(Clone)]
pub struct AppHandle {
    shared: Arc<Shared>,
}

impl AppHandle {
    #[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
    pub(crate) async fn spawn(
        builder: AppBuilder,
        options: WorkerOptions,
        limits: Limits,
    ) -> Result<Self> {
        let (sender, receiver) = mpsc::channel(options.queue_capacity.get());
        let shutdown = Arc::new(watch::channel(false).0);
        let (report, status) = watch::channel(WorkerStatus::Running);
        let key = new_key();
        let max_held = options.instances.max_held_connections;
        let held = Arc::new(Semaphore::new(max_held));
        let builder = builder.keyed(key);
        let pool = match runtime::Pool::start(builder, options, receiver, shutdown.clone(), report)
            .await
        {
            Ok(pool) => pool,
            Err(Error::WorkerClosed) => {
                wait_for_shutdown(status).await?;
                return Err(Error::WorkerClosed);
            }
            Err(error) => return Err(error),
        };
        Ok(Self {
            shared: Arc::new(Shared {
                sender,
                shutdown,
                status,
                limits,
                key,
                held,
                max_held,
                refused_connections: AtomicU64::new(0),
                pool,
            }),
        })
    }

    pub fn limits(&self) -> &Limits {
        &self.shared.limits
    }

    /// Reserve a place for a connection that holds an instance, such as a
    /// server WebSocket, or None when
    /// [`Instances::max_held_connections`](super::Instances::max_held_connections)
    /// are all taken. Put it in the extensions of the upgrade request; see
    /// [`HeldConnection`].
    pub fn reserve_connection(&self) -> Option<HeldConnection> {
        let place = HeldConnection::try_reserve(&self.shared.held);
        if place.is_none() {
            self.shared
                .refused_connections
                .fetch_add(1, Ordering::Relaxed);
        }
        place
    }

    /// What the instances and queue are doing, and totals since the spawn;
    /// see [`PoolState`].
    #[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
    pub fn pool_state(&self) -> PoolState {
        let shared = &self.shared;
        PoolState {
            queued: shared.sender.max_capacity() - shared.sender.capacity(),
            held_connections: shared.max_held - shared.held.available_permits(),
            refused_connections: shared.refused_connections.load(Ordering::Relaxed),
            ..shared.pool.state()
        }
    }

    /// [`Instances::max_held_connections`](super::Instances::max_held_connections):
    /// 0 when this application holds no connections.
    pub fn max_held_connections(&self) -> usize {
        self.shared.max_held
    }

    pub async fn call_json(&self, export: &str, arguments: &[Value]) -> Result<Value> {
        let call = Call::with_arguments(export.to_owned(), arguments.to_vec());
        Ok(self.call_with(call).await?.into_value())
    }

    /// Call a function with the arguments and context of `call`, on
    /// whichever instance takes it.
    pub async fn call_with(&self, call: Call) -> Result<CallOutput> {
        let (reply, receive) = oneshot::channel();
        self.enqueue(Command::Call { call, reply }).await?;
        self.receive(receive).await
    }

    pub async fn call<I: Serialize + Sync + ?Sized, O: DeserializeOwned>(
        &self,
        export: &str,
        input: &I,
    ) -> Result<O> {
        let input = serde_json::to_value(input)
            .map_err(|error| Error::InvalidRequest(error.to_string()))?;
        let call = Call::with_arguments(export.to_owned(), vec![input]);
        self.call_with(call).await?.deserialize()
    }

    pub async fn fetch(&self, request: Request) -> Result<Response> {
        self.fetch_inner(request, None).await
    }

    pub async fn fetch_with_context<C: Serialize + Sync + ?Sized>(
        &self,
        request: Request,
        context: &C,
    ) -> Result<Response> {
        let context = serde_json::to_value(context)
            .map_err(|error| Error::InvalidRequest(error.to_string()))?;
        self.fetch_inner(request, Some(context)).await
    }

    /// Stop accepting calls, finish accepted work, and wait for resource cleanup.
    ///
    /// Every clone observes the shutdown. Completion uses the same cooperative
    /// execution model as ordinary calls.
    pub async fn shutdown(&self) -> Result<()> {
        self.shared.shutdown.send_replace(true);
        wait_for_shutdown(self.shared.status.clone()).await
    }

    async fn fetch_inner(&self, request: Request, context: Option<Value>) -> Result<Response> {
        let (reply, receive) = oneshot::channel();
        self.enqueue(Command::Fetch {
            request: Box::new(request),
            context,
            reply,
        })
        .await?;
        self.receive(receive).await
    }

    async fn enqueue(&self, command: Command) -> Result<()> {
        // The worker is running the invocation whose host fetch makes this
        // call, so the call could only complete after itself.
        if is_polling(self.shared.key) {
            return Err(Error::Reentrant);
        }
        let mut stopping = self.shared.shutdown.subscribe();
        if *stopping.borrow() {
            return Err(Error::WorkerClosed);
        }
        let permit = tokio::select! {
            permit = self.shared.sender.reserve() => permit.map_err(|_| Error::WorkerClosed)?,
            _ = stopping.wait_for(|requested| *requested) => return Err(Error::WorkerClosed),
        };
        if *stopping.borrow() {
            return Err(Error::WorkerClosed);
        }
        permit.send(command);
        #[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
        {
            let sender = &self.shared.sender;
            self.shared
                .pool
                .grow(sender.max_capacity() - sender.capacity());
        }
        Ok(())
    }

    async fn receive<T>(&self, reply: oneshot::Receiver<Result<T>>) -> Result<T> {
        match reply.await {
            Ok(result) => result,
            Err(_) => {
                wait_for_shutdown(self.shared.status.clone()).await?;
                Err(Error::WorkerClosed)
            }
        }
    }
}
