use bytes::Bytes;
use serde_json::{Value, json};

use crate::{Error, WebLimits, WebState};

/// The version of the operation names and messages. The guest runtime uses
/// host implementations only when it was built for the same version.
pub const PROTOCOL_VERSION: u32 = 2;

/// The embedder's byte store for the current invocation, which carries
/// binary data between the guest and the host by handle.
pub trait ByteHandles {
    /// The embedder's error, which also represents this crate's errors.
    type Error: From<Error>;

    /// Store bytes for the guest to take, returning their handle.
    fn put(&mut self, bytes: Bytes) -> Result<u64, Self::Error>;

    /// Take the bytes the guest stored under `handle`.
    fn take(&mut self, handle: u64) -> Result<Bytes, Self::Error>;
}

/// The current invocation: its Web API state and its byte store.
pub struct Invocation<'a, B> {
    pub state: &'a mut WebState,
    pub bytes: &'a mut B,
}

/// The Web APIs this build implements, reported by the `web.capabilities`
/// operation so the guest runtime installs only those globals.
pub fn capabilities() -> Value {
    let mut apis = Vec::new();
    if cfg!(feature = "url") {
        apis.push("url");
    }
    if cfg!(feature = "url-pattern") {
        apis.push("url-pattern");
    }
    if cfg!(feature = "compression") {
        apis.push("compression");
    }
    if cfg!(feature = "crypto") {
        apis.push("crypto");
    }
    json!({ "protocol": PROTOCOL_VERSION, "apis": apis })
}

/// Run a Web API operation, or return `None` when `operation` is not one,
/// so the embedder can route its own operations.
///
/// Stateless operations, such as URL parsing, also run without an
/// invocation, for example while a module is evaluated.
pub fn dispatch<B: ByteHandles>(
    operation: &str,
    input: &str,
    limits: &WebLimits,
    invocation: Option<Invocation<'_, B>>,
) -> Option<Result<Value, B::Error>> {
    let _ = (input, limits, &invocation);
    let result = match operation {
        "web.capabilities" => Ok(capabilities()),
        #[cfg(feature = "url")]
        "url.parse" | "url.set" => crate::url::dispatch(operation, input),
        #[cfg(feature = "url-pattern")]
        "urlpattern.parse" | "urlpattern.match" => crate::url_pattern::dispatch(operation, input),
        #[cfg(feature = "crypto")]
        "crypto.random" | "crypto.digest" | "crypto.generateKey" | "crypto.importKey"
        | "crypto.exportKey" | "crypto.sign" | "crypto.verify" | "crypto.encrypt"
        | "crypto.decrypt" | "crypto.deriveBits" => {
            crate::crypto::dispatch(operation, input, limits)
        }
        #[cfg(feature = "compression")]
        "compression.open" | "compression.write" | "compression.finish" | "compression.read"
        | "compression.close" => {
            let Some(invocation) = invocation else {
                return Some(Err(Error::NoInvocation.into()));
            };
            return Some(crate::compression::dispatch(
                operation, input, limits, invocation,
            ));
        }
        _ => return None,
    };
    Some(result.map_err(B::Error::from))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    #[derive(Default)]
    struct Store {
        next: u64,
        entries: BTreeMap<u64, Bytes>,
    }

    impl ByteHandles for Store {
        type Error = Error;

        fn put(&mut self, bytes: Bytes) -> Result<u64, Error> {
            self.next += 1;
            self.entries.insert(self.next, bytes);
            Ok(self.next)
        }

        fn take(&mut self, handle: u64) -> Result<Bytes, Error> {
            self.entries
                .remove(&handle)
                .ok_or_else(|| Error::InvalidRequest("unknown handle".into()))
        }
    }

    fn run(operation: &str, input: &str, invocation: Option<Invocation<'_, Store>>) -> Value {
        dispatch(operation, input, &WebLimits::default(), invocation)
            .expect("a Web API operation")
            .expect("a successful operation")
    }

    #[test]
    fn reports_the_protocol_and_leaves_other_operations_to_the_embedder() {
        let reply = run("web.capabilities", "null", None);
        assert_eq!(reply["protocol"], PROTOCOL_VERSION);
        assert!(dispatch::<Store>("fetch.start", "{}", &WebLimits::default(), None).is_none());
    }

    #[cfg(not(any(
        feature = "url",
        feature = "url-pattern",
        feature = "compression",
        feature = "crypto"
    )))]
    #[test]
    fn omitted_apis_are_neither_reported_nor_served() {
        assert_eq!(capabilities()["apis"], json!([]));
        for operation in [
            "url.parse",
            "urlpattern.parse",
            "compression.open",
            "crypto.random",
        ] {
            assert!(dispatch::<Store>(operation, "null", &WebLimits::default(), None).is_none());
        }
    }

    #[cfg(feature = "url")]
    #[test]
    fn stateless_operations_run_without_an_invocation() {
        assert_eq!(capabilities()["apis"][0], "url");
        let reply = run("url.parse", r#"["https://a.test/x", null]"#, None);
        assert_eq!(reply[0], "https://a.test/x");
    }

    #[cfg(feature = "compression")]
    #[test]
    fn stateful_operations_need_an_invocation_and_keep_its_state() {
        assert!(matches!(
            dispatch::<Store>(
                "compression.open",
                r#"["gzip", false]"#,
                &WebLimits::default(),
                None
            ),
            Some(Err(Error::NoInvocation))
        ));
        let mut state = WebState::default();
        let mut store = Store::default();
        let mut step = |operation: &str, input: &str| {
            run(
                operation,
                input,
                Some(Invocation {
                    state: &mut state,
                    bytes: &mut store,
                }),
            )
        };
        let id = step("compression.open", r#"["gzip", false]"#).to_string();
        step("compression.finish", &id);
        let handle = step("compression.read", &id);
        step("compression.close", &id);
        let piece = store.take(handle.as_u64().unwrap()).unwrap();
        assert_eq!(&piece[..2], &[0x1f, 0x8b]);
        // A fresh state, as for the next invocation, has no codec under that id.
        let mut next = WebState::default();
        let reply = dispatch(
            "compression.finish",
            &id,
            &WebLimits::default(),
            Some(Invocation {
                state: &mut next,
                bytes: &mut store,
            }),
        );
        assert!(matches!(reply, Some(Err(Error::InvalidRequest(_)))));
    }
}
