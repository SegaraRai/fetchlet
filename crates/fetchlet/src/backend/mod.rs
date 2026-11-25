mod code_cache;
mod engine;
mod selection;
mod startup;

#[cfg(feature = "boa")]
mod boa;
#[cfg(feature = "quickjs")]
mod quickjs;
#[cfg(feature = "v8")]
mod v8;

pub use selection::Backend;

#[cfg(feature = "boa")]
pub use boa::{Boa, BoaOptions};
#[cfg(feature = "quickjs")]
pub use quickjs::{QuickJs, QuickJsOptions};
#[cfg(feature = "v8")]
pub use v8::{MIN_V8_HEAP_LIMIT_BYTES, V8, V8Options};

pub(crate) use code_cache::CodeCache;
pub(crate) use engine::Engine;
pub(crate) use startup::Startup;

#[cfg(any(feature = "quickjs", feature = "v8"))]
pub(crate) use code_cache::Script;
#[cfg(feature = "v8")]
pub(crate) use startup::Check;
