#![cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]

//! A module's requirements are checked against the engine before the module
//! is evaluated: a host that lacks one refuses to build the App, with one
//! error that names everything missing.

use std::num::NonZeroUsize;

use fetchlet::{App, Backend, Error, Module, Requirements, WorkerOptions};

/// A module that fails in its own way if it is ever evaluated.
const SOURCE: &str = r#"
throw new Error("the module ran");
"#;

/// A module that runs when its requirements are met.
const RUNS: &str = r#"
globalThis.fetchletExports = { ok: () => "ok" };
"#;

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

fn build(backend: Backend, source: &str, requirements: Requirements) -> fetchlet::Result<App> {
    App::builder(backend)
        .module(Module::new(source).requires(requirements))
        .build()
}

fn refusal(backend: Backend, requirements: Requirements) -> String {
    match build(backend, SOURCE, requirements) {
        Err(Error::Configuration(message)) => message,
        Err(other) => panic!("expected a configuration error, got {other:?}"),
        Ok(_) => panic!("expected the build to be refused"),
    }
}

fn is_v8(backend: &Backend) -> bool {
    format!("{backend:?}").starts_with("V8")
}

fn is_quickjs(backend: &Backend) -> bool {
    format!("{backend:?}").starts_with("QuickJs")
}

#[tokio::test]
async fn met_requirements_let_the_module_run() -> anyhow::Result<()> {
    for backend in backends() {
        let mut requirements = Requirements::new()
            .engine_api("JSON.parse")
            .engine_api("Promise")
            .host_protocol(fetchlet_web::PROTOCOL_VERSION);
        if cfg!(feature = "url") {
            requirements = requirements.host_api("url");
        }
        let mut app = build(backend, RUNS, requirements)?;
        assert_eq!(app.call_json("ok", &[]).await?, "ok");
    }
    Ok(())
}

#[test]
fn a_missing_engine_api_refuses_before_the_module_runs() {
    for backend in backends() {
        let message = refusal(
            backend,
            Requirements::new()
                .engine_api("JSON")
                .engine_api("FetchletMissing.api"),
        );
        assert!(message.contains("native FetchletMissing.api"), "{message}");
        assert!(!message.contains("native JSON"), "{message}");
    }
}

#[test]
fn native_intl_is_present_only_on_v8() {
    for backend in backends() {
        let requirements = Requirements::new()
            .engine_api("Intl.DateTimeFormat")
            .locales(["en"]);
        let result = build(backend, RUNS, requirements);
        if is_v8(&backend) {
            assert!(result.is_ok(), "{:?}", result.err());
        } else {
            let Err(Error::Configuration(message)) = result else {
                panic!("expected a configuration error");
            };
            assert!(message.contains("native Intl.DateTimeFormat"), "{message}");
        }
    }
}

#[cfg(feature = "v8")]
#[test]
fn locales_count_for_apis_that_support_them() {
    let message = refusal(
        Backend::v8(),
        Requirements::new()
            .engine_api("Intl.NumberFormat")
            .locales(["en", "qaa-x-fetchlet"]),
    );
    assert!(
        message.contains("native Intl.NumberFormat (qaa-x-fetchlet)"),
        "{message}"
    );
}

#[test]
fn async_context_is_missing_only_on_quickjs() {
    for backend in backends() {
        let result = build(backend, RUNS, Requirements::new().async_context());
        if is_quickjs(&backend) {
            let Err(Error::Configuration(message)) = result else {
                panic!("expected a configuration error");
            };
            assert!(message.contains("async context"), "{message}");
            assert!(message.contains("QuickJS"), "{message}");
        } else {
            assert!(result.is_ok(), "{:?}", result.err());
        }
    }
}

#[test]
fn unknown_host_apis_and_other_protocols_are_missing() {
    for backend in backends() {
        let message = refusal(
            backend,
            Requirements::new()
                .host_api("crypto")
                .host_api("teleport")
                .host_protocol(fetchlet_web::PROTOCOL_VERSION + 1),
        );
        assert!(message.contains("the teleport Web API"), "{message}");
        assert_eq!(
            message.contains("the crypto Web API"),
            !cfg!(feature = "web-crypto"),
            "{message}"
        );
        assert!(
            message.contains(&format!(
                "fetchlet-web protocol {}",
                fetchlet_web::PROTOCOL_VERSION + 1
            )),
            "{message}"
        );
    }
}

#[test]
fn one_error_names_every_miss() {
    for backend in backends() {
        let message = refusal(
            backend,
            Requirements::new()
                .engine_api("FetchletMissing")
                .host_api("teleport")
                .host_protocol(0),
        );
        assert!(
            message.contains("native FetchletMissing, fetchlet-web protocol 0"),
            "{message}"
        );
        assert!(message.contains(" and the teleport Web API"), "{message}");
    }
}

#[tokio::test]
async fn pools_refuse_as_a_single_app_does() {
    for backend in backends() {
        let result = App::builder(backend)
            .module(Module::new(SOURCE).requires(Requirements::new().engine_api("FetchletMissing")))
            .spawn(WorkerOptions::new(NonZeroUsize::new(2).unwrap()))
            .await;
        assert!(
            matches!(result, Err(Error::Configuration(_))),
            "{:?}",
            result.err()
        );
    }
}
