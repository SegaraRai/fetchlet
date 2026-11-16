use std::net::IpAddr;

use serde::Serialize;

/// Default metadata passed as the Fetch entry's second argument.
///
/// Framework adapters read `clientAddress`, for example SvelteKit's
/// `getClientAddress()`.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_address: Option<String>,
}

impl RequestContext {
    pub fn new(client_address: Option<IpAddr>) -> Self {
        Self {
            client_address: client_address.map(|address| address.to_string()),
        }
    }
}
