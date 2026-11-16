use std::net::SocketAddr;

use axum::extract::ConnectInfo;
use axum::http::request::Parts;
use serde::Serialize;

/// Default metadata passed as the Fetch entry's second argument.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_address: Option<String>,
}

impl RequestContext {
    pub(super) fn from_parts(parts: &Parts) -> Self {
        Self {
            client_address: parts
                .extensions
                .get::<ConnectInfo<SocketAddr>>()
                .map(|ConnectInfo(address)| address.ip().to_string()),
        }
    }
}
