#![cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]

//! Tasks that host transports spawn, such as a pooled connection, run on the
//! host runtime, so an instance busy in JavaScript does not hold them up.

use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tokio::sync::{mpsc, oneshot};

use fetchlet::{
    App, AppHandle, Backend, Body, FetchPolicy, FetchService, HostServices, Instances, Module,
    Response, WorkerOptions, transport_fn,
};

const SOURCE: &str = include_str!("fixtures/pool.js");
const HOST_THREAD: &str = "fetchlet-host-test";

fn backends() -> Vec<Backend> {
    vec![
        #[cfg(feature = "quickjs")]
        Backend::quickjs(),
        #[cfg(feature = "boa")]
        Backend::boa(),
        #[cfg(feature = "v8")]
        Backend::v8(),
    ]
}

/// One connection that every request reuses, served by a task that the
/// first request spawns, as pooled HTTP clients do.
#[derive(Default)]
struct Connection {
    requests: OnceLock<mpsc::UnboundedSender<oneshot::Sender<()>>>,
    /// The thread the connection task ran on for each request.
    threads: Mutex<Vec<String>>,
}

impl Connection {
    async fn send(self: &Arc<Self>) {
        let requests = self.requests.get_or_init(|| {
            let (sender, mut receiver) = mpsc::unbounded_channel::<oneshot::Sender<()>>();
            let connection = self.clone();
            tokio::spawn(async move {
                while let Some(reply) = receiver.recv().await {
                    let thread = std::thread::current().name().unwrap_or("").to_owned();
                    connection.threads.lock().unwrap().push(thread);
                    let _ = reply.send(());
                }
            });
            sender
        });
        let (reply, response) = oneshot::channel();
        requests.send(reply).unwrap();
        response.await.unwrap();
    }
}

/// A runtime that its own thread keeps driving, standing in for a server's.
fn host_runtime() -> tokio::runtime::Handle {
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name(HOST_THREAD.into())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            sender.send(runtime.handle().clone()).unwrap();
            runtime.block_on(std::future::pending::<()>());
        })
        .unwrap();
    receiver.recv().unwrap()
}

async fn spawn(
    backend: Backend,
    connection: Arc<Connection>,
    runtime: Option<tokio::runtime::Handle>,
) -> fetchlet::Result<AppHandle> {
    let service = FetchService::new(
        transport_fn(move |_| {
            let connection = connection.clone();
            async move {
                connection.send().await;
                Ok(Response::new(Body::empty()))
            }
        }),
        FetchPolicy::deny_all().allow_origin("https://connection.test")?,
    );
    let mut options = WorkerOptions::new(NonZeroUsize::new(8).unwrap());
    options.instances = Instances::fixed(NonZeroUsize::new(2).unwrap());
    let mut builder = App::builder(backend)
        .module(Module::new(SOURCE))
        .host_services(HostServices::new().outbound(service));
    if let Some(runtime) = runtime {
        builder = builder.host_runtime(runtime);
    }
    builder.spawn(options).await
}

/// How long a fetch on the second instance takes while the first instance,
/// which opened the connection, spins for `spin`.
async fn reuse_while_busy(handle: &AppHandle, connection: &Connection, spin: Duration) -> Duration {
    let busy = handle.clone();
    let spinning = tokio::spawn(async move {
        busy.call_json("fetchThenSpin", &[(spin.as_millis() as u64).into()])
            .await
    });
    // Wait until the first fetch went through the connection.
    let started = Instant::now();
    while connection.threads.lock().unwrap().is_empty() {
        assert!(started.elapsed() < Duration::from_secs(10), "first fetch");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;

    let started = Instant::now();
    handle.call_json("fetchOnce", &[]).await.unwrap();
    let elapsed = started.elapsed();
    spinning.await.unwrap().unwrap();
    elapsed
}

#[tokio::test]
async fn a_shared_connection_progresses_while_an_instance_is_busy() -> anyhow::Result<()> {
    let runtime = host_runtime();
    for backend in backends() {
        let connection = Arc::new(Connection::default());
        let handle = spawn(backend, connection.clone(), Some(runtime.clone())).await?;
        let elapsed = reuse_while_busy(&handle, &connection, Duration::from_secs(3)).await;
        assert!(elapsed < Duration::from_millis(1500), "{elapsed:?}");
        let threads = connection.threads.lock().unwrap().clone();
        assert_eq!(threads, [HOST_THREAD, HOST_THREAD]);
        handle.shutdown().await?;
    }
    Ok(())
}

/// QuickJS and Boa run JavaScript on the worker thread, whose runtime the
/// connection task belongs to. V8 runs its isolate on a thread of its own and
/// leaves the worker's runtime free, so it does not wait.
#[tokio::test]
async fn without_a_host_runtime_the_connection_waits_for_its_instance() -> anyhow::Result<()> {
    let backends = [
        #[cfg(feature = "quickjs")]
        Backend::quickjs(),
        #[cfg(feature = "boa")]
        Backend::boa(),
    ];
    for backend in backends {
        let connection = Arc::new(Connection::default());
        let handle = spawn(backend, connection.clone(), None).await?;
        let elapsed = reuse_while_busy(&handle, &connection, Duration::from_millis(1500)).await;
        assert!(elapsed >= Duration::from_millis(1000), "{elapsed:?}");
        let threads = connection.threads.lock().unwrap().clone();
        assert_eq!(threads, ["fetchlet-app", "fetchlet-app"]);
        handle.shutdown().await?;
    }
    Ok(())
}
