use std::fmt;
use std::ops::RangeInclusive;

use url::Host;

use crate::{Error, Result};

/// A TCP destination: a host name or IP literal, and a port.
///
/// The host is normalized as URLs normalize hosts: names are lowercased and
/// converted to ASCII, IPv4 literals take their dotted decimal form and IPv6
/// literals their bracketed, compressed form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SocketAddress {
    hostname: String,
    port: u16,
}

impl SocketAddress {
    /// Parse a host and a nonzero port.
    pub fn new(hostname: &str, port: u16) -> Result<Self> {
        if port == 0 {
            return Err(Error::InvalidRequest("invalid socket port".into()));
        }
        Ok(Self {
            hostname: normalize_host(hostname)?,
            port,
        })
    }

    /// The normalized host, with brackets around an IPv6 literal.
    pub fn hostname(&self) -> &str {
        &self.hostname
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// The host without brackets, as name resolution and TLS take it.
    pub fn host(&self) -> &str {
        self.hostname
            .strip_prefix('[')
            .and_then(|host| host.strip_suffix(']'))
            .unwrap_or(&self.hostname)
    }
}

impl fmt::Display for SocketAddress {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}:{}", self.hostname, self.port)
    }
}

fn normalize_host(host: &str) -> Result<String> {
    // An IPv6 literal may come with or without brackets.
    let bracketed = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    match Host::parse(&bracketed) {
        Ok(host) if !host.to_string().is_empty() => Ok(host.to_string()),
        _ => Err(Error::InvalidRequest("invalid socket host".into())),
    }
}

/// Exact normalized hosts, each with the ports it allows; no wildcard or
/// suffix matching.
///
/// The policy authorizes the address JavaScript names, after any rewrite.
/// It performs no name resolution: a transport that connects to a network
/// must check the addresses a name resolves to, as fetchlet-http's
/// `TcpTransport` refuses private and loopback addresses unless allowed.
#[derive(Debug, Clone, Default)]
pub struct SocketPolicy {
    rules: Vec<(String, RangeInclusive<u16>)>,
}

impl SocketPolicy {
    pub fn deny_all() -> Self {
        Self::default()
    }

    /// Allow one host and port.
    pub fn allow(self, host: &str, port: u16) -> Result<Self> {
        self.allow_ports(host, port..=port)
    }

    /// Allow a host on a range of ports.
    pub fn allow_ports(mut self, host: &str, ports: RangeInclusive<u16>) -> Result<Self> {
        if ports.is_empty() || *ports.start() == 0 {
            return Err(Error::Configuration("invalid socket port range".into()));
        }
        let host =
            normalize_host(host).map_err(|_| Error::Configuration("invalid socket host".into()))?;
        self.rules.push((host, ports));
        Ok(self)
    }

    pub fn check(&self, address: &SocketAddress) -> Result<()> {
        let allowed = self
            .rules
            .iter()
            .any(|(host, ports)| *host == address.hostname && ports.contains(&address.port));
        if allowed {
            Ok(())
        } else {
            Err(Error::PermissionDenied)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_are_normalized_and_matched_exactly() -> Result<()> {
        let policy = SocketPolicy::deny_all()
            .allow("DB.Example.TEST", 5432)?
            .allow_ports("::1", 6379..=6380)?
            .allow("127.0.0.1", 9000)?;
        assert!(
            policy
                .check(&SocketAddress::new("db.example.test", 5432)?)
                .is_ok()
        );
        assert!(policy.check(&SocketAddress::new("[::1]", 6380)?).is_ok());
        assert!(policy.check(&SocketAddress::new("0:0::1", 6379)?).is_ok());
        assert!(
            policy
                .check(&SocketAddress::new("127.0.0.1", 9000)?)
                .is_ok()
        );

        for (host, port) in [
            ("db.example.test", 5433),
            ("sub.db.example.test", 5432),
            ("example.test", 5432),
            ("::1", 6381),
            ("127.0.0.2", 9000),
        ] {
            assert!(
                matches!(
                    policy.check(&SocketAddress::new(host, port)?),
                    Err(Error::PermissionDenied)
                ),
                "{host}:{port}"
            );
        }
        Ok(())
    }

    #[test]
    fn invalid_addresses_and_rules_are_refused() {
        assert!(SocketAddress::new("", 80).is_err());
        assert!(SocketAddress::new("host name", 80).is_err());
        assert!(SocketAddress::new("example.test", 0).is_err());
        assert!(SocketPolicy::deny_all().allow("example.test", 0).is_err());
        #[allow(clippy::reversed_empty_ranges)]
        let empty = 10..=9;
        assert!(
            SocketPolicy::deny_all()
                .allow_ports("example.test", empty)
                .is_err()
        );
        let address = SocketAddress::new("::1", 443).unwrap();
        assert_eq!(address.to_string(), "[::1]:443");
        assert_eq!(address.host(), "::1");
    }
}
