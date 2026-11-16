use serde_json::Value;

/// Low-level engine execution. App supplies invocation and host-service ownership.
/// Instances are not necessarily Send; keep them on their owning worker thread.
#[allow(async_fn_in_trait)]
pub trait Instance {
    async fn call_json(&mut self, export: &str, args: &[Value]) -> anyhow::Result<Value>;
    fn is_reusable(&self) -> bool;
}
