use crate::wire::{WireRequest, WireResponse};
use crate::{Error, Instance, Limits, Request, Response, Result};

/// Low-level Fetch adapter; prefer App for managed deadlines and host services.
pub struct FetchApp<I> {
    pub instance: I,
    pub export: String,
}
impl<I: Instance> FetchApp<I> {
    pub async fn handle(&mut self, request: Request) -> Result<Response> {
        let limits = Limits::default();
        let wire = WireRequest::from_http(request, &limits)?;
        let input =
            serde_json::to_value(wire).map_err(|error| Error::InvalidRequest(error.to_string()))?;
        let value = self
            .instance
            .call_json(&self.export, &[input])
            .await
            .map_err(|error| Error::JavaScript(error.to_string()))?;
        let response: WireResponse = serde_json::from_value(value)
            .map_err(|error| Error::InvalidRequest(error.to_string()))?;
        response.into_http(&limits)
    }
}
