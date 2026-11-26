use std::path::PathBuf;
use std::time::Duration;

/// Where an App's engine runs: in the embedder's process, or in a child
/// process of its own (docs/research/process-isolation.md).
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub enum Isolation {
    /// The engine runs in this process, as without the `process` feature.
    #[default]
    InProcess,
    /// The engine runs in a child process. Host services, policies and
    /// `Functions` stay in this process; the child reaches them only through
    /// the guest's host operations. Deadlines, cancellation and the busy and
    /// startup timeouts stop the instance on every engine by ending the
    /// child, and an engine crash ends only the instance.
    Process(ProcessOptions),
}

/// How the child process of an isolated instance starts and what bounds it.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct ProcessOptions {
    /// The executable the child runs. It must call
    /// [`serve_if_child`](crate::serve_if_child) first thing in `main` and
    /// include the engine features of this build.
    pub program: Program,
    /// Caller budget for the child's whole memory: engine heap, compiled
    /// code and stacks. The operating system enforces it, and reaching it
    /// fails the call with `LimitExceeded("process memory")` and retires the
    /// instance. None leaves the child unbounded beyond `Limits::heap_bytes`.
    ///
    /// On Windows a Job Object bounds the committed memory. On Linux the
    /// child limits its data segment (`RLIMIT_DATA`: heap, anonymous
    /// writable mappings and thread stacks, not the address space engines
    /// only reserve) before it builds the engine. V8 on x64 Linux reserves
    /// its code range writable, so a V8 budget there must exceed it: V8
    /// starts under 768 MiB but not under 512 MiB. Elsewhere a value is
    /// refused at build time.
    pub memory_bytes: Option<usize>,
    /// The native stack of the child's engine thread. None uses Rust's
    /// default for spawned threads (2 MiB unless `RUST_MIN_STACK` says
    /// otherwise). Engine stack limits, such as
    /// `QuickJsOptions::stack_limit_bytes` and Boa's value stack, must fit
    /// it, as they must fit the thread an in-process engine runs on.
    pub stack_bytes: Option<usize>,
    /// Caller policy: how long past `Limits::busy_timeout` or
    /// `Limits::startup_timeout` the parent waits for the engine's own
    /// interrupt before it ends the child. The engine's interrupt gives the
    /// precise error where it can stop JavaScript; ending the child is the
    /// backstop on every engine.
    pub kill_grace: Duration,
}

impl Default for ProcessOptions {
    fn default() -> Self {
        Self {
            program: Program::CurrentExe,
            memory_bytes: None,
            stack_bytes: None,
            // Long enough for QuickJS's and V8's interrupts, which stop
            // JavaScript within milliseconds, to report first.
            kill_grace: Duration::from_millis(100),
        }
    }
}

impl ProcessOptions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn program(mut self, program: Program) -> Self {
        self.program = program;
        self
    }

    pub fn memory_bytes(mut self, bytes: usize) -> Self {
        self.memory_bytes = Some(bytes);
        self
    }

    pub fn stack_bytes(mut self, bytes: usize) -> Self {
        self.stack_bytes = Some(bytes);
        self
    }

    pub fn kill_grace(mut self, grace: Duration) -> Self {
        self.kill_grace = grace;
        self
    }

    pub(crate) fn validate(&self) -> crate::Result<()> {
        if self.memory_bytes == Some(0) {
            return Err(crate::Error::Configuration(
                "ProcessOptions::memory_bytes must be positive".into(),
            ));
        }
        if self.stack_bytes == Some(0) {
            return Err(crate::Error::Configuration(
                "ProcessOptions::stack_bytes must be positive".into(),
            ));
        }
        if self.memory_bytes.is_some() && !cfg!(any(windows, target_os = "linux")) {
            return Err(crate::Error::Configuration(
                "ProcessOptions::memory_bytes is enforced only on Windows and Linux".into(),
            ));
        }
        Ok(())
    }
}

/// The executable of an isolated instance's child process.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum Program {
    /// This process's own executable, started in child mode.
    CurrentExe,
    /// Another executable, such as a smaller one with only the engines.
    Path(PathBuf),
}
