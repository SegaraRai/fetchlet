#![cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]

//! Origin routing, the trusted Context and reentrancy of in-process services.

use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use fetchlet::{
    App, AppHandle, Backend, Body, Context, Error, HostServices, Limits, Module, OriginRouter,
    Request, Response, WorkerOptions, http, transport_fn,
};

const SOURCE: &str = include_str!("fixtures/in-process.js");

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

/// The trusted caller identity, chosen by the Rust host.
#[derive(Clone)]
struct Caller(&'static str);

fn caller(request: &Request) -> &'static str {
    Context::of(request)
        .and_then(|context| context.get::<Caller>())
        .map_or("anonymous", |Caller(name)| name)
}

fn text(status: u16, body: String) -> Response {
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = http::StatusCode::from_u16(status).unwrap();
    response
}

/// Calls reaching the internal route, and the applications it may call.
#[derive(Default)]
struct Internal {
    calls: AtomicUsize,
    same: OnceLock<AppHandle>,
    other: OnceLock<AppHandle>,
}

impl Internal {
    async fn handle(&self, request: Request) -> fetchlet::Result<Response> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let header = request
            .headers()
            .get("x-caller")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("none")
            .to_owned();
        match request.uri().path() {
            "/whoami" => Ok(text(200, format!("{}|{header}", caller(&request)))),
            "/to-external" => {
                let mut response = text(302, String::new());
                response.headers_mut().insert(
                    http::header::LOCATION,
                    http::HeaderValue::from_static("https://external.test/whoami"),
                );
                Ok(response)
            }
            "/failure" => Err(Error::Transport("detail".into())),
            "/reenter" => {
                let same = self.same.get().expect("handle").clone();
                same.fetch(relay("/global?to=https://fetchlet.internal/whoami", None))
                    .await
            }
            "/other" => {
                let other = self.other.get().expect("handle").clone();
                let value = other.call_json("ping", &[]).await?;
                Ok(text(200, value.as_str().unwrap_or_default().to_owned()))
            }
            _ => Ok(text(404, "missing".into())),
        }
    }
}

fn services(internal: Arc<Internal>) -> fetchlet::Result<HostServices> {
    let router = OriginRouter::new()
        .internal(
            "https://fetchlet.internal",
            transport_fn(move |request| {
                let internal = internal.clone();
                async move { internal.handle(request).await }
            }),
        )?
        .external(
            "https://external.test",
            transport_fn(|request: Request| async move {
                Ok(text(200, format!("external:{}", caller(&request))))
            }),
        )?;
    let service = router.into_service();
    HostServices::new()
        .outbound(service.clone())
        .service("API", service)
}

fn limits() -> Limits {
    Limits {
        timeout: Some(Duration::from_secs(10)),
        ..Limits::default()
    }
}

fn relay(path: &str, context: Option<Context>) -> Request {
    let mut request = http::Request::builder()
        .uri(format!("https://app.test{path}"))
        .body(Body::empty())
        .unwrap();
    if let Some(context) = context {
        request.extensions_mut().insert(context);
    }
    request
}

async fn outcome(response: Response) -> (u16, String) {
    let status = response.status().as_u16();
    let body = response.into_body().collect(1024).await.unwrap();
    (status, String::from_utf8_lossy(&body).into_owned())
}

fn alice() -> Option<Context> {
    Some(Context::new().with(Caller("alice")))
}

#[tokio::test]
async fn the_context_reaches_internal_routes_only() -> anyhow::Result<()> {
    for backend in backends() {
        let internal = Arc::new(Internal::default());
        let mut app = App::builder(backend)
            .module(Module::new(SOURCE))
            .host_services(services(internal.clone())?)
            .limits(limits())
            .build()?;

        for entry in ["global", "binding"] {
            let path = format!("/{entry}?to=https://fetchlet.internal/whoami");
            let response = app.fetch(relay(&path, alice())).await?;
            // The header JavaScript set does not identify the caller.
            assert_eq!(
                outcome(response).await,
                (200, "alice|forged".into()),
                "{entry}"
            );
        }

        let anonymous = app
            .fetch(relay("/global?to=https://fetchlet.internal/whoami", None))
            .await?;
        assert_eq!(outcome(anonymous).await.1, "anonymous|forged");

        let external = app
            .fetch(relay("/global?to=https://external.test/whoami", alice()))
            .await?;
        assert_eq!(outcome(external).await.1, "external:anonymous");

        // An internal redirect to an external route leaves the Context behind.
        let redirected = app
            .fetch(relay(
                "/global?to=https://fetchlet.internal/to-external",
                alice(),
            ))
            .await?;
        assert_eq!(
            outcome(redirected).await,
            (200, "external:anonymous".into())
        );

        let missing = app
            .fetch(relay(
                "/binding?to=https://fetchlet.internal/nothing",
                alice(),
            ))
            .await?;
        assert_eq!(outcome(missing).await, (404, "missing".into()));

        let failure = app
            .fetch(relay(
                "/binding?to=https://fetchlet.internal/failure",
                alice(),
            ))
            .await?;
        assert_eq!(outcome(failure).await, (599, "TRANSPORT".into()));

        // Unregistered origins are denied before any route runs.
        let calls = internal.calls.load(Ordering::SeqCst);
        for target in [
            "https://other.test/whoami",
            "http://fetchlet.internal/whoami",
        ] {
            let denied = app
                .fetch(relay(&format!("/global?to={target}"), alice()))
                .await?;
            assert_eq!(outcome(denied).await, (599, "PERMISSION_DENIED".into()));
        }
        assert_eq!(internal.calls.load(Ordering::SeqCst), calls);
    }
    Ok(())
}

async fn spawn(services: HostServices, backend: Backend) -> fetchlet::Result<AppHandle> {
    App::builder(backend)
        .module(Module::new(SOURCE))
        .host_services(services)
        .limits(limits())
        .spawn(WorkerOptions::new(NonZeroUsize::new(4).unwrap()))
        .await
}

#[tokio::test]
async fn a_host_fetch_cannot_call_its_own_application() -> anyhow::Result<()> {
    for backend in backends() {
        let internal = Arc::new(Internal::default());
        let handle = spawn(services(internal.clone())?, backend).await?;
        let other = spawn(HostServices::new(), backend).await?;
        internal.same.set(handle.clone()).ok().unwrap();
        internal.other.set(other.clone()).ok().unwrap();

        // Refused at once instead of waiting for the invocation deadline.
        let started = Instant::now();
        let response = handle
            .fetch(relay(
                "/binding?to=https://fetchlet.internal/reenter",
                alice(),
            ))
            .await?;
        assert_eq!(outcome(response).await, (599, "REENTRANT".into()));
        assert!(started.elapsed() < Duration::from_secs(5));

        // Another application is not affected, and this one stays usable.
        let response = handle
            .fetch(relay(
                "/binding?to=https://fetchlet.internal/other",
                alice(),
            ))
            .await?;
        assert_eq!(outcome(response).await, (200, "pong".into()));
        let response = handle
            .fetch(relay(
                "/global?to=https://fetchlet.internal/whoami",
                alice(),
            ))
            .await?;
        assert_eq!(outcome(response).await.1, "alice|forged");

        // Outside a host fetch, calls from the test are not refused.
        assert_eq!(handle.call_json("ping", &[]).await?, "pong");
        handle.shutdown().await?;
        other.shutdown().await?;
    }
    Ok(())
}
