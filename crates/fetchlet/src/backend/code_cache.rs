//! Compiled code that the instances of one application share, so that only
//! the first instance compiles each script: QuickJS bytecode, and a V8 code
//! cache made after the script's first run, when it holds the functions the
//! top level compiled. Boa has no serialized form and compiles every time.
//!
//! An [`AppBuilder`](crate::AppBuilder) owns the cache, and the instances
//! built from it and its clones, such as those of one pool, use it. It holds
//! one entry per engine and script, at most the prelude, the host bridge and
//! the module: its size is set by the scripts themselves, about three times
//! the module source for QuickJS and less than its source for V8. Setting
//! another module on the builder starts a new cache, so an entry always
//! belongs to the source it was compiled from: QuickJS does not verify
//! bytecode, and V8 checks only the source length.
// With Boa alone, the builder holds an empty cache.
#![cfg_attr(not(any(feature = "quickjs", feature = "v8")), allow(dead_code))]

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

/// A script every instance evaluates while it starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Script {
    Prelude,
    Bridge,
    Module,
}

/// Compiled code by engine name and script.
type Entries = HashMap<(&'static str, Script), Arc<[u8]>>;

#[derive(Debug, Default)]
pub(crate) struct CodeCache {
    entries: Mutex<Entries>,
}

impl CodeCache {
    /// The compiled form of `script` for `engine`, if an instance made it.
    pub fn get(&self, engine: &'static str, script: Script) -> Option<Arc<[u8]>> {
        self.lock().get(&(engine, script)).cloned()
    }

    /// Keep the compiled form of `script`, replacing one the engine refused.
    pub fn put(&self, engine: &'static str, script: Script, code: &[u8]) {
        self.lock().insert((engine, script), Arc::from(code));
    }

    /// Bytes of compiled code held.
    #[cfg(test)]
    pub fn bytes(&self) -> usize {
        self.lock().values().map(|code| code.len()).sum()
    }

    fn lock(&self) -> MutexGuard<'_, Entries> {
        // Entries are complete values, so a panic elsewhere leaves none half
        // written.
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }
}
