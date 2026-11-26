//! What a new instance evaluates, and the check of the module's
//! requirements that runs before the module: the static part against the
//! backend and fetchlet-web, and engine APIs through a probe evaluated in
//! the instance itself.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::{Backend, CodeCache};
use crate::execution::Interrupt;
use crate::{Error, Limits, Module, Requirements, Result};

/// The module an instance evaluates, with the check it passes first and
/// the compiled code it shares with the other instances of its application.
pub(crate) struct Startup<'a> {
    source: &'a str,
    check: Check,
    code_cache: Option<Arc<CodeCache>>,
    /// `Limits::busy_timeout`, for the instance's interrupt.
    busy_timeout: Option<Duration>,
    /// `Limits::startup_timeout`.
    startup_timeout: Option<Duration>,
    /// `Limits::heap_bytes`, which `AppBuilder::build` has checked against
    /// the backend.
    heap_bytes: Option<usize>,
}

impl<'a> Startup<'a> {
    pub fn new(
        module: &'a Module,
        backend: &Backend,
        code_cache: Arc<CodeCache>,
        limits: &Limits,
    ) -> Self {
        let requirements = module.requirements();
        Self {
            source: module.source(),
            check: Check {
                unmet: static_unmet(requirements, backend),
                engine: backend.engine_name(),
                probe: probe_script(requirements),
            },
            code_cache: Some(code_cache),
            busy_timeout: limits.busy_timeout,
            startup_timeout: limits.startup_timeout,
            heap_bytes: limits.heap_bytes,
        }
    }

    /// A module evaluated without requirements, for engines built directly.
    pub fn unchecked(source: &'a str) -> Self {
        Self {
            source,
            check: Check {
                unmet: Vec::new(),
                engine: "",
                probe: None,
            },
            code_cache: None,
            busy_timeout: None,
            startup_timeout: None,
            heap_bytes: None,
        }
    }

    pub fn source(&self) -> &'a str {
        self.source
    }

    pub fn check(&self) -> &Check {
        &self.check
    }

    /// The interrupt of the instance being built, with its busy timeout.
    pub fn interrupt(&self) -> Interrupt {
        Interrupt::new(self.busy_timeout)
    }

    /// When the module's evaluation must have ended, from now.
    pub fn deadline(&self) -> Option<Instant> {
        self.startup_timeout
            .and_then(|timeout| Instant::now().checked_add(timeout))
    }

    /// `Limits::startup_timeout`.
    #[cfg_attr(not(feature = "v8"), allow(dead_code))]
    pub fn startup_timeout(&self) -> Option<Duration> {
        self.startup_timeout
    }

    /// `Limits::heap_bytes`, None for an engine built directly.
    #[cfg_attr(not(any(feature = "quickjs", feature = "v8")), allow(dead_code))]
    pub fn heap_bytes(&self) -> Option<usize> {
        self.heap_bytes
    }

    /// The application's compiled code, None for an engine built directly.
    #[cfg_attr(not(any(feature = "quickjs", feature = "v8")), allow(dead_code))]
    pub fn code_cache(&self) -> Option<&Arc<CodeCache>> {
        self.code_cache.as_ref()
    }
}

/// The check of a module's requirements, which an engine runs after its
/// runtime and before the module. It owns its data, so an engine on another
/// thread can take it.
#[derive(Clone)]
pub(crate) struct Check {
    /// Requirements the backend and fetchlet-web lack.
    unmet: Vec<String>,
    /// The engine the requirements are checked against, for messages.
    engine: &'static str,
    /// A script whose value is the JSON list of missing engine APIs.
    probe: Option<String>,
}

impl Check {
    /// The script to evaluate when engine APIs need checking. Its value is
    /// a JSON string.
    pub fn probe(&self) -> Option<&str> {
        self.probe.as_deref()
    }

    /// Whether the module may run, given the probe's value when there was a
    /// probe: `Error::Configuration` naming every missing requirement if not.
    pub fn admit(&self, report: Option<&str>) -> Result<()> {
        let mut missing = Vec::new();
        if let Some(report) = report {
            let engine: Vec<String> = serde_json::from_str(report).map_err(|_| {
                Error::JavaScript("the engine probe returned an invalid report".into())
            })?;
            missing.extend(engine.into_iter().map(|api| format!("native {api}")));
        }
        missing.extend(self.unmet.iter().cloned());
        if missing.is_empty() {
            return Ok(());
        }
        Err(Error::Configuration(format!(
            "the module needs {}, which this host's {} engine does not provide; build the artifact for this engine, or change the host's engine or features",
            list(&missing),
            self.engine
        )))
    }
}

/// Requirements a backend and the compiled fetchlet-web answer without
/// running JavaScript.
fn static_unmet(requirements: &Requirements, backend: &Backend) -> Vec<String> {
    let mut unmet = Vec::new();
    if requirements.needs_async_context() && !backend.has_async_context() {
        unmet.push("async context".to_owned());
    }
    if requirements.needs_preemption()
        && let Err(gap) = backend.preemption()
    {
        unmet.push(format!("preemption ({gap})"));
    }
    let capabilities = fetchlet_web::capabilities();
    let served: Vec<&str> = capabilities["apis"]
        .as_array()
        .map(|apis| apis.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if let Some(version) = requirements.protocol()
        && version != fetchlet_web::PROTOCOL_VERSION
    {
        unmet.push(format!(
            "fetchlet-web protocol {version} (this host speaks {})",
            fetchlet_web::PROTOCOL_VERSION
        ));
    }
    for api in requirements.host_apis() {
        if !served.contains(&api) {
            unmet.push(format!("the {api} Web API"));
        }
    }
    unmet
}

/// A script that looks up each engine API from `globalThis` and, for one
/// with `supportedLocalesOf`, each required locale, and returns the JSON
/// list of what is missing.
fn probe_script(requirements: &Requirements) -> Option<String> {
    let apis: Vec<&str> = requirements.engine_apis().collect();
    if apis.is_empty() {
        return None;
    }
    let input = json!({ "apis": apis, "locales": requirements.locale_list() });
    Some(format!(
        r#"((input) => {{
  const missing = [];
  for (const api of input.apis) {{
    let value = globalThis;
    for (const key of api.split(".")) {{
      value = value === undefined || value === null ? undefined : value[key];
    }}
    if (value === undefined || value === null) {{
      missing.push(api);
      continue;
    }}
    if (typeof value.supportedLocalesOf === "function") {{
      const absent = input.locales.filter((locale) => value.supportedLocalesOf([locale]).length === 0);
      if (absent.length > 0) {{
        missing.push(api + " (" + absent.join(", ") + ")");
      }}
    }}
  }}
  return JSON.stringify(missing);
}})({input})"#
    ))
}

/// `a`, `a and b`, `a, b and c`.
fn list(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [only] => only.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_read_as_english() {
        let items = |items: &[&str]| {
            items
                .iter()
                .map(|item| (*item).to_owned())
                .collect::<Vec<_>>()
        };
        assert_eq!(list(&items(&["a"])), "a");
        assert_eq!(list(&items(&["a", "b"])), "a and b");
        assert_eq!(list(&items(&["a", "b", "c"])), "a, b and c");
    }

    #[test]
    fn a_module_without_requirements_needs_no_probe() {
        let module = Module::new("");
        let startup = Startup::unchecked(module.source());
        assert!(startup.check().probe().is_none());
        assert!(startup.check().admit(None).is_ok());
    }
}
