use std::time::{Duration, Instant};

use crate::{Error, Result};

/// Resource budgets selected by the embedding application.
///
/// Each Some value enables that budget. None delegates the resource budget to
/// the surrounding host, such as an HTTP server or a process supervisor.
#[derive(Debug, Clone, Default)]
pub struct Limits {
    /// Cooperative duration of one invocation, including host I/O and timers.
    pub timeout: Option<Duration>,
    /// Byte budget for each input or outbound request body.
    pub request_body_bytes: Option<usize>,
    /// Chunk budget when reading a guest outbound request, including empty chunks.
    pub request_body_chunks: Option<usize>,
    /// Byte budget for each output or upstream response body.
    pub response_body_bytes: Option<usize>,
    /// Combined name and value bytes in one header collection.
    pub header_bytes: Option<usize>,
    /// URL bytes at request conversion and after trusted rewrites.
    pub url_bytes: Option<usize>,
    /// Bytes in each JSON input to a native host callback.
    pub bridge_message_bytes: Option<usize>,
    /// Input bytes of one `crypto.subtle.digest` call, or of one `node:crypto`
    /// hash or HMAC.
    pub digest_bytes: Option<usize>,
    /// Modulus length, in bits, of an RSA key that `crypto.subtle` generates.
    pub rsa_modulus_bits: Option<usize>,
    /// Iterations of one PBKDF2 derivation in `crypto.subtle` or `node:crypto`.
    pub pbkdf2_iterations: Option<usize>,
    /// Working memory, 128 * r * (N + p + 2) bytes as OpenSSL counts it for
    /// `maxmem`, of one `node:crypto` scrypt derivation, which the host
    /// allocates.
    pub scrypt_memory_bytes: Option<usize>,
    /// `CompressionStream` and `DecompressionStream` instances open at once
    /// in one invocation.
    pub compression_streams: Option<usize>,
    /// Output bytes of each `DecompressionStream`.
    pub decompressed_bytes: Option<usize>,
    /// Host fetch starts attempted during one invocation, including failed starts.
    pub subrequests: Option<usize>,
    /// Redirects followed per fetch, within the Fetch specification's limit.
    pub redirects: Option<usize>,
    /// Cooperative duration of background work registered with
    /// `fetchlet.waitUntil`, from the end of the invocation's result or body.
    pub background_timeout: Option<Duration>,
    /// `fetchlet.waitUntil` registrations during one invocation.
    pub background_tasks: Option<usize>,
    /// Bytes of one message on a channel, such as a WebSocket message, in
    /// either direction. A caller budget: neither RFC 6455 nor TCP sets a
    /// maximum. A message from JavaScript over it closes the channel with
    /// code 1009.
    pub channel_message_bytes: Option<usize>,
    /// Bytes queued in each direction of a channel. Rust's sender waits for
    /// room; a JavaScript send past it closes the channel with code 1009, as
    /// WebSocket has no way to make `send` wait.
    pub channel_buffer_bytes: Option<usize>,
    /// How long a held connection, such as a server WebSocket, stays open
    /// without a message in either direction. Running out closes it with
    /// code 1001.
    pub connection_idle_timeout: Option<Duration>,
    /// How long a held connection stays open from its upgrade. Running out
    /// closes it with code 1001. JavaScript then has `timeout` more to handle
    /// the close before the instance retires.
    pub connection_lifetime: Option<Duration>,
}

impl Limits {
    pub(crate) fn validate(&self) -> Result<()> {
        for (name, timeout) in [
            ("background_timeout", self.background_timeout),
            ("connection_idle_timeout", self.connection_idle_timeout),
            ("connection_lifetime", self.connection_lifetime),
            ("timeout", self.timeout),
        ] {
            let exceeds_clock_range =
                timeout.is_some_and(|timeout| Instant::now().checked_add(timeout).is_none());
            if exceeds_clock_range {
                return Err(Error::Configuration(format!(
                    "{name} exceeds the platform clock range"
                )));
            }
        }

        Ok(())
    }
}

#[cfg(feature = "web")]
impl Limits {
    /// The budgets that `fetchlet-web` operations enforce.
    pub(crate) fn web(&self) -> fetchlet_web::WebLimits {
        fetchlet_web::WebLimits {
            digest_bytes: self.digest_bytes,
            compression_streams: self.compression_streams,
            decompressed_bytes: self.decompressed_bytes,
            rsa_modulus_bits: self.rsa_modulus_bits,
            pbkdf2_iterations: self.pbkdf2_iterations,
            scrypt_memory_bytes: self.scrypt_memory_bytes,
        }
    }
}

pub(crate) fn check_limit(
    limit: Option<usize>,
    observed: usize,
    resource: &'static str,
) -> Result<()> {
    if limit.is_some_and(|limit| observed > limit) {
        return Err(Error::LimitExceeded(resource));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_limit_allows_its_own_value_and_refuses_more() {
        assert!(check_limit(Some(10), 10, "bytes").is_ok());
        assert!(check_limit(Some(0), 0, "bytes").is_ok());
        assert!(matches!(
            check_limit(Some(10), 11, "request body bytes"),
            Err(Error::LimitExceeded("request body bytes"))
        ));
        assert!(check_limit(None, usize::MAX, "bytes").is_ok());
    }

    #[test]
    fn timeouts_must_fit_the_platform_clock() {
        assert!(Limits::default().validate().is_ok());
        let limits = Limits {
            timeout: Some(Duration::from_secs(30)),
            background_timeout: Some(Duration::ZERO),
            ..Limits::default()
        };
        assert!(limits.validate().is_ok());
        for (limits, name) in [
            (
                Limits {
                    timeout: Some(Duration::MAX),
                    ..Limits::default()
                },
                "timeout",
            ),
            (
                Limits {
                    background_timeout: Some(Duration::MAX),
                    ..Limits::default()
                },
                "background_timeout",
            ),
        ] {
            match limits.validate() {
                Err(Error::Configuration(message)) => {
                    assert_eq!(message, format!("{name} exceeds the platform clock range"));
                }
                other => panic!("expected a configuration error, got {other:?}"),
            }
        }
    }

    #[cfg(feature = "web")]
    #[test]
    fn web_operations_receive_their_budgets() {
        let limits = Limits {
            digest_bytes: Some(1),
            compression_streams: Some(2),
            decompressed_bytes: Some(3),
            rsa_modulus_bits: Some(4),
            pbkdf2_iterations: Some(5),
            scrypt_memory_bytes: Some(7),
            request_body_bytes: Some(6),
            ..Limits::default()
        };
        let web = limits.web();
        assert_eq!(
            (
                web.digest_bytes,
                web.compression_streams,
                web.decompressed_bytes,
                web.rsa_modulus_bits,
                web.pbkdf2_iterations,
                web.scrypt_memory_bytes,
            ),
            (Some(1), Some(2), Some(3), Some(4), Some(5), Some(7))
        );
    }
}
