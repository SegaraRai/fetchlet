//! Host implementations of Web APIs for fetchlet guests.
//!
//! The guest runtime calls these as host operations: a name, a JSON message
//! and byte-store handles. They depend on no JavaScript engine, so QuickJS,
//! Boa and V8 share one implementation of each API.

mod dispatch;
mod error;
mod limits;
mod protocol;
mod state;

#[cfg(feature = "compression")]
mod compression;
#[cfg(feature = "web-crypto")]
mod crypto;
#[cfg(feature = "node-crypto")]
mod node_crypto;
#[cfg(feature = "url")]
mod url;
#[cfg(feature = "url-pattern")]
mod url_pattern;

pub use dispatch::{ByteHandles, Invocation, capabilities, dispatch};
pub use error::{Error, Result};
pub use limits::WebLimits;
pub use protocol::PROTOCOL_VERSION;
pub use state::WebState;

#[cfg(feature = "compression")]
pub use compression::{CompressionFormat, Decompressor};
