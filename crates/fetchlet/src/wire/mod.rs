mod codec;

pub(crate) use codec::{WireRequest, WireResponse, normalize_fetch_method, validate_headers};

#[cfg(test)]
mod tests;
