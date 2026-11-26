/// Boa interpreter limits. None uses the engine's own setting (10,240 value
/// stack slots and 512 nested calls in Boa 0.22).
///
/// Boa keeps JavaScript frames on its own value stack rather than the native
/// one, so these limits, not the worker's thread stack, bound how deeply a
/// framework renderer may recurse.
#[derive(Debug, Clone, Copy, Default)]
#[cfg_attr(feature = "process", derive(serde::Serialize, serde::Deserialize))]
pub struct BoaOptions {
    /// The value stack size, in slots, before a call throws `RuntimeLimitError`.
    pub stack_size_limit: Option<usize>,
    /// The number of nested JavaScript calls before a call throws.
    pub recursion_limit: Option<usize>,
    /// The loop iterations one call frame may run before Boa stops it with
    /// an error JavaScript cannot catch. Boa cannot be interrupted inside
    /// its interpreter, so this count, not a time, bounds a loop that never
    /// calls the host or queues a promise job. A caller budget; None keeps
    /// Boa's own, which is unlimited.
    pub loop_iteration_limit: Option<u64>,
}

impl BoaOptions {
    pub(crate) fn validate(&self) -> crate::Result<()> {
        if self.stack_size_limit == Some(0)
            || self.recursion_limit == Some(0)
            || self.loop_iteration_limit == Some(0)
        {
            return Err(crate::Error::Configuration(
                "engine resource sizes must be positive".into(),
            ));
        }
        Ok(())
    }

    pub(crate) fn apply(&self, context: &mut boa_engine::Context) {
        let limits = context.runtime_limits_mut();
        if let Some(slots) = self.stack_size_limit {
            limits.set_stack_size_limit(slots);
        }
        if let Some(depth) = self.recursion_limit {
            limits.set_recursion_limit(depth);
        }
        if let Some(iterations) = self.loop_iteration_limit {
            limits.set_loop_iteration_limit(iterations);
        }
    }
}
