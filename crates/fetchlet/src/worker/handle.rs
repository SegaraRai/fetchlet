use std::sync::Arc;

use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot, watch};

use super::lifecycle::{WorkerStatus, wait_for_shutdown};
use super::protocol::Command;
use super::{WorkerOptions, runtime};
use crate::{AppBuilder, Error, Limits, Request, Response, Result};

struct Shared {
    sender: mpsc::Sender<Command>,
    shutdown: watch::Sender<bool>,
    status: watch::Receiver<WorkerStatus>,
    limits: Limits,
}

/// A cloneable Send + Sync handle to one application on its owning thread.
///
/// Calls execute serially. The configured mailbox applies backpressure before
/// accepting more work. Dropping a call future cancels that call; the worker
/// recreates a retired instance before the next call.
#[derive(Clone)]
pub struct AppHandle {
    shared: Arc<Shared>,
}

impl AppHandle {
    pub(crate) async fn spawn(
        builder: AppBuilder,
        options: WorkerOptions,
        limits: Limits,
    ) -> Result<Self> {
        let (sender, receiver) = mpsc::channel(options.queue_capacity.get());
        let (shutdown, stopping) = watch::channel(false);
        let (report, status) = watch::channel(WorkerStatus::Running);
        let (initialized, ready) = oneshot::channel();
        runtime::spawn(builder, options, receiver, stopping, initialized, report)?;
        let handle = Self {
            shared: Arc::new(Shared {
                sender,
                shutdown,
                status,
                limits,
            }),
        };
        match ready.await {
            Ok(result) => result?,
            Err(_) => {
                wait_for_shutdown(handle.shared.status.clone()).await?;
                return Err(Error::WorkerClosed);
            }
        }
        Ok(handle)
    }

    pub fn limits(&self) -> &Limits {
        &self.shared.limits
    }

    pub async fn call_json(&self, export: &str, arguments: &[Value]) -> Result<Value> {
        let (reply, receive) = oneshot::channel();
        self.enqueue(Command::Call {
            export: export.to_owned(),
            arguments: arguments.to_vec(),
            reply,
        })
        .await?;
        self.receive(receive).await
    }

    pub async fn call<I: Serialize + Sync + ?Sized, O: DeserializeOwned>(
        &self,
        export: &str,
        input: &I,
    ) -> Result<O> {
        let input = serde_json::to_value(input)
            .map_err(|error| Error::InvalidRequest(error.to_string()))?;
        let result = self.call_json(export, &[input]).await?;
        serde_json::from_value(result)
            .map_err(|error| Error::JavaScript(format!("invalid result: {error}")))
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
