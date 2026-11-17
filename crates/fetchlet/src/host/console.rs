use std::fmt;
use std::sync::Arc;

/// The console method a message came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConsoleLevel {
    Debug,
    Log,
    Info,
    Warn,
    Error,
}

// The host bridge reads console messages; it exists only where a guest runs.
#[cfg(any(
    feature = "boa",
    feature = "quickjs",
    feature = "v8",
    feature = "fuzzing",
    test
))]
impl ConsoleLevel {
    pub(crate) fn parse(name: &str) -> Option<Self> {
        match name {
            "debug" => Some(Self::Debug),
            "log" => Some(Self::Log),
            "info" => Some(Self::Info),
            "warn" => Some(Self::Warn),
            "error" => Some(Self::Error),
            _ => None,
        }
    }
}

/// Receives the console output of the App's JavaScript, one formatted
/// message per call. The callback runs on the thread that executes the
/// JavaScript, so it should hand messages on rather than block.
///
/// Without an engine feature, `HostServices` still accepts a sink, but no
/// guest runs to write to it.
#[derive(Clone)]
pub(crate) struct ConsoleSink(
    #[cfg_attr(
        not(any(
            feature = "boa",
            feature = "quickjs",
            feature = "v8",
            feature = "fuzzing",
            test
        )),
        expect(dead_code, reason = "only the host bridge calls the sink")
    )]
    Arc<ConsoleCallback>,
);

type ConsoleCallback = dyn Fn(ConsoleLevel, &str) + Send + Sync;

impl ConsoleSink {
    pub fn new(sink: impl Fn(ConsoleLevel, &str) + Send + Sync + 'static) -> Self {
        Self(Arc::new(sink))
    }

    #[cfg(any(
        feature = "boa",
        feature = "quickjs",
        feature = "v8",
        feature = "fuzzing",
        test
    ))]
    pub fn write(&self, level: ConsoleLevel, message: &str) {
        (self.0)(level, message);
    }
}

impl fmt::Debug for ConsoleSink {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ConsoleSink")
    }
}
