#![cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]

//! Several instances behind one `AppHandle`: the shared queue, growth to
//! `max`, retirement of idle instances, per-instance state, reentrancy and
//! shutdown.

use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::{Semaphore, mpsc};

use fetchlet::{
    App, AppHandle, Backend, Body, Error, FetchPolicy, FetchService, HostServices, Instances,
    Module, PoolState, Response, WorkerOptions, transport_fn,
};

const SOURCE: &str = include_str!("fixtures/pool.js");

/// A name no instance has had, which the first call to an instance keeps.
fn unique_name() -> Value {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    json!(format!("instance-{}", NEXT.fetch_add(1, Ordering::Relaxed)))
}

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

fn count(value: usize) -> NonZeroUsize {
    NonZeroUsize::new(value).unwrap()
}

/// The host side of the fixture's fetches: `gate.test` reports that a call
/// entered it and waits for a permit; `reenter.test` calls the application.
struct Host {
    entered: mpsc::UnboundedSender<()>,
    gate: Arc<Semaphore>,
    application: OnceLock<AppHandle>,
}

struct Pool {
    handle: AppHandle,
    entered: mpsc::UnboundedReceiver<()>,
    gate: Arc<Semaphore>,
}

impl Pool {
    async fn spawn(backend: Backend, instances: Instances) -> fetchlet::Result<Self> {
        let (entered, receive) = mpsc::unbounded_channel();
        let host = Arc::new(Host {
            entered,
            gate: Arc::new(Semaphore::new(0)),
            application: OnceLock::new(),
        });
        let transport_host = host.clone();
        let service = FetchService::new(
            transport_fn(move |request: fetchlet::Request| {
                let host = transport_host.clone();
                async move {
                    if request.uri().host() == Some("reenter.test") {
                        let application = host.application.get().expect("handle is set");
                        application.call_json("instance", &[unique_name()]).await?;
                    } else {
                        host.entered.send(()).unwrap();
                        host.gate.acquire().await.unwrap().forget();
                    }
                    Ok(Response::new(Body::empty()))
                }
            }),
            FetchPolicy::deny_all()
                .allow_origin("https://gate.test")?
                .allow_origin("https://reenter.test")?,
        );
        let mut options = WorkerOptions::new(count(8));
        options.instances = instances;
        let handle = App::builder(backend)
            .module(Module::new(SOURCE))
            .host_services(HostServices::new().outbound(service))
            .spawn(options)
            .await?;
        host.application.set(handle.clone()).ok().unwrap();
        Ok(Self {
            handle,
            entered: receive,
            gate: host.gate.clone(),
        })
    }

    /// Start `wait` and return once it is inside the host fetch.
    async fn start_waiting(&mut self) -> tokio::task::JoinHandle<fetchlet::Result<Value>> {
        let handle = self.handle.clone();
        let task = tokio::spawn(async move { handle.call_json("wait", &[unique_name()]).await });
        within("the call to enter the host fetch", self.entered.recv())
            .await
            .unwrap();
        task
    }

    async fn instance(&self) -> fetchlet::Result<String> {
        Ok(self
            .handle
            .call_json("instance", &[unique_name()])
            .await?
            .as_str()
            .unwrap()
            .to_owned())
    }
}

/// The pool's state once `condition` holds of it.
async fn state_when(handle: &AppHandle, condition: impl Fn(&PoolState) -> bool) -> PoolState {
    within("the pool state", async {
        loop {
            let state = handle.pool_state();
            if condition(&state) {
                return state;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
}

async fn within<T>(what: &str, future: impl Future<Output = T>) -> T {
    match tokio::time::timeout(Duration::from_secs(10), future).await {
        Ok(output) => output,
        Err(_) => panic!("timed out waiting for {what}"),
    }
}

#[tokio::test]
async fn a_busy_instance_does_not_hold_the_queue() -> anyhow::Result<()> {
    for backend in backends() {
        let mut pool = Pool::spawn(backend, Instances::fixed(count(2))).await?;
        let waiting = pool.start_waiting().await;

        // The other instance answers while the first waits.
        let other = within("step 1", pool.instance()).await?;
        assert!(!waiting.is_finished());

        pool.gate.add_permits(1);
        let first = within("step 2", waiting).await??;
        assert_ne!(first.as_str(), Some(other.as_str()));
        pool.handle.shutdown().await?;
    }
    Ok(())
}

#[tokio::test]
async fn one_instance_serves_calls_in_turn() -> anyhow::Result<()> {
    for backend in backends() {
        let mut pool = Pool::spawn(backend, Instances::default()).await?;
        let waiting = pool.start_waiting().await;

        let mut queued = Box::pin(pool.instance());
        assert!(
            tokio::time::timeout(Duration::from_millis(200), &mut queued)
                .await
                .is_err()
        );

        pool.gate.add_permits(1);
        let first = within("step 3", waiting).await??;
        assert_eq!(
            first.as_str(),
            Some(within("step 4", queued).await?.as_str())
        );
        pool.handle.shutdown().await?;
    }
    Ok(())
}

#[tokio::test]
async fn the_pool_grows_on_demand_and_retires_idle_instances() -> anyhow::Result<()> {
    for backend in backends() {
        let instances = Instances {
            min: count(1),
            max: count(2),
            idle_timeout: Some(Duration::from_millis(100)),
            max_held_connections: 0,
        };
        let mut pool = Pool::spawn(backend, instances).await?;
        let first = pool.instance().await?;

        // A queued call starts a second instance while the first waits.
        let waiting = pool.start_waiting().await;
        let grown = within("step 5", pool.instance()).await?;
        assert_ne!(grown, first);
        pool.gate.add_permits(1);
        assert_eq!(
            within("step 6", waiting).await??.as_str(),
            Some(first.as_str())
        );

        // Beyond max, a call waits for a free instance.
        let first_waiting = pool.start_waiting().await;
        let second_waiting = pool.start_waiting().await;
        let mut queued = Box::pin(pool.instance());
        assert!(
            tokio::time::timeout(Duration::from_millis(200), &mut queued)
                .await
                .is_err()
        );
        pool.gate.add_permits(2);
        within("step 7", first_waiting).await??;
        within("step 8", second_waiting).await??;
        let served = within("step 9", queued).await?;
        assert!(served == first || served == grown);

        // Once idle past the timeout, the pool is back to one of the two;
        // a second concurrent call needs a new instance.
        tokio::time::sleep(Duration::from_millis(500)).await;
        let waiting = pool.start_waiting().await;
        let fresh = within("step 10", pool.instance()).await?;
        pool.gate.add_permits(1);
        let survivor = within("step 11", waiting).await??;
        assert!(survivor == json!(first) || survivor == json!(grown));
        assert_ne!(fresh, first);
        assert_ne!(fresh, grown);
        pool.handle.shutdown().await?;
    }
    Ok(())
}

#[tokio::test]
async fn each_instance_keeps_its_own_state() -> anyhow::Result<()> {
    for backend in backends() {
        let mut pool = Pool::spawn(backend, Instances::fixed(count(2))).await?;
        // With one instance waiting, every other call reaches the second.
        let waiting = pool.start_waiting().await;
        for expected in 1..=3 {
            assert_eq!(
                within("step 12", pool.handle.call_json("calls", &[])).await?,
                json!(expected)
            );
        }
        pool.gate.add_permits(1);
        within("step 13", waiting).await??;
        pool.handle.shutdown().await?;
    }
    Ok(())
}

#[tokio::test]
async fn a_host_fetch_cannot_call_its_own_pool() -> anyhow::Result<()> {
    for backend in backends() {
        let pool = Pool::spawn(backend, Instances::fixed(count(2))).await?;
        // Refused even though another instance is idle.
        assert_eq!(
            within("step 14", pool.handle.call_json("reenter", &[])).await?,
            json!("REENTRANT")
        );
        pool.handle.shutdown().await?;
    }
    Ok(())
}

#[tokio::test]
async fn shutdown_finishes_accepted_calls_on_every_instance() -> anyhow::Result<()> {
    for backend in backends() {
        let mut pool = Pool::spawn(backend, Instances::fixed(count(2))).await?;
        let first = pool.start_waiting().await;
        let second = pool.start_waiting().await;

        let handle = pool.handle.clone();
        let shutdown = tokio::spawn(async move { handle.shutdown().await });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!shutdown.is_finished());
        assert!(matches!(
            pool.handle.call_json("instance", &[unique_name()]).await,
            Err(Error::WorkerClosed)
        ));

        pool.gate.add_permits(2);
        within("step 15", first).await??;
        within("step 16", second).await??;
        within("step 17", shutdown).await??;
    }
    Ok(())
}

#[tokio::test]
async fn min_above_max_is_a_configuration_error() -> anyhow::Result<()> {
    for backend in backends() {
        let instances = Instances {
            min: count(2),
            max: count(1),
            idle_timeout: None,
            max_held_connections: 0,
        };
        assert!(matches!(
            Pool::spawn(backend, instances).await,
            Err(Error::Configuration(_))
        ));
    }
    Ok(())
}

#[tokio::test]
async fn shutdown_without_calls_finishes() -> anyhow::Result<()> {
    for backend in backends() {
        for instances in [Instances::default(), Instances::fixed(count(2))] {
            let pool = Pool::spawn(backend, instances).await?;
            within("shutdown", pool.handle.shutdown()).await?;
        }
    }
    Ok(())
}

#[tokio::test]
async fn the_state_follows_instances_and_the_queue() -> anyhow::Result<()> {
    for backend in backends() {
        let instances = Instances {
            min: count(1),
            max: count(2),
            idle_timeout: Some(Duration::from_millis(100)),
            max_held_connections: 0,
        };
        let mut pool = Pool::spawn(backend, instances).await?;
        // A worker reads as busy from its ready report until it waits.
        let state = state_when(&pool.handle, |state| state.idle == 1).await;
        assert_eq!(
            (state.busy, state.building, state.builds),
            (0, 0, 1),
            "{backend:?}"
        );
        assert_eq!(
            (
                state.min,
                state.max,
                state.queue_capacity,
                state.max_held_connections
            ),
            (1, 2, 8, 0)
        );
        assert!(state.build_time > Duration::ZERO);

        let first = pool.start_waiting().await;
        let state = state_when(&pool.handle, |state| state.busy == 1).await;
        assert_eq!((state.idle, state.queued, state.builds), (0, 0, 1));

        // A second waiting call grows the pool to max; a third waits.
        let second = pool.start_waiting().await;
        let state = state_when(&pool.handle, |state| state.busy == 2).await;
        assert_eq!(state.builds, 2);
        let handle = pool.handle.clone();
        let queued = tokio::spawn(async move { handle.call_json("calls", &[]).await });
        let state = state_when(&pool.handle, |state| state.queued == 1).await;
        assert_eq!((state.busy, state.idle, state.builds), (2, 0, 2));

        pool.gate.add_permits(2);
        within("first", first).await??;
        within("second", second).await??;
        within("queued", queued).await??;

        // Past the idle timeout, the instance above min stops.
        let state = state_when(&pool.handle, |state| state.idle_retirements == 1).await;
        assert_eq!(state.replaced, 0);
        state_when(&pool.handle, |state| {
            (state.idle, state.busy, state.retiring, state.queued) == (1, 0, 0, 0)
        })
        .await;
        pool.handle.shutdown().await?;
    }
    Ok(())
}

#[tokio::test]
async fn an_abandoned_call_counts_its_replacement() -> anyhow::Result<()> {
    for backend in backends() {
        let mut pool = Pool::spawn(backend, Instances::default()).await?;
        let waiting = pool.start_waiting().await;
        waiting.abort();
        let state = state_when(&pool.handle, |state| state.replaced == 1 && state.idle == 1).await;
        assert_eq!(
            (
                state.builds,
                state.failed_builds,
                state.busy,
                state.building
            ),
            (2, 0, 0, 0),
            "{backend:?}"
        );
        pool.handle.shutdown().await?;
    }
    Ok(())
}

#[tokio::test]
async fn the_state_counts_held_and_refused_connections() -> anyhow::Result<()> {
    for backend in backends() {
        let instances = Instances {
            max_held_connections: 1,
            ..Instances::fixed(count(2))
        };
        let pool = Pool::spawn(backend, instances).await?;
        let place = pool.handle.reserve_connection().expect("a free place");
        assert!(pool.handle.reserve_connection().is_none());
        let state = pool.handle.pool_state();
        assert_eq!((state.held_connections, state.refused_connections), (1, 1));
        drop(place);
        let state = pool.handle.pool_state();
        assert_eq!((state.held_connections, state.refused_connections), (0, 1));
        pool.handle.shutdown().await?;
    }
    Ok(())
}
