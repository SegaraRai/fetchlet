//! JavaScript functions and Fetch handlers hosted by Rust.

mod config;
mod error;
mod execution;
mod fetch;
mod host;
mod reentry;
mod wire;
mod worker;

#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
mod app;
#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
mod backend;
#[cfg(any(
    feature = "boa",
    feature = "quickjs",
    feature = "v8",
    feature = "fuzzing",
    test
))]
mod bridge;

pub use config::Limits;
pub use error::{Error, Result};
pub use execution::Instance;
pub use fetch::{Body, FetchApp, Request, Response};
pub use host::{
    ChannelEnd, ChannelEvent, CloseFrame, ConsoleLevel, Context, FetchPolicy, FetchService,
    FetchTransport, HostServices, Message, OriginRouter, ServerWebSocket, TransportFuture,
    transport_fn,
};
pub use http;
pub use worker::{AppHandle, CancelledCalls, HeldConnection, Instances, WorkerOptions};

#[cfg(feature = "fuzzing")]
#[doc(hidden)]
pub use bridge::{BodyFeed, BridgeHarness};

#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
pub use app::{App, AppBuilder, Module};
#[cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]
pub use backend::Backend;
#[cfg(feature = "boa")]
pub use backend::{Boa, BoaOptions};
#[cfg(feature = "quickjs")]
pub use backend::{QuickJs, QuickJsOptions};
#[cfg(feature = "v8")]
pub use backend::{V8, V8Options};
