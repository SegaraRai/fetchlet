use std::collections::BTreeMap;

use super::FetchService;
use crate::{Error, Result};

/// Fixed bindings and services for one App. No process environment is inherited.
#[derive(Clone, Default)]
pub struct HostServices {
    pub(crate) outbound: Option<FetchService>,
    pub(crate) services: BTreeMap<String, FetchService>,
    pub(crate) env: BTreeMap<String, String>,
}

impl HostServices {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn outbound(mut self, service: FetchService) -> Self {
        self.outbound = Some(service);
        self
    }

    pub fn service(mut self, name: impl Into<String>, service: FetchService) -> Result<Self> {
        let name = name.into();
        if self.services.contains_key(&name) || self.env.contains_key(&name) {
            return Err(Error::Configuration("duplicate binding".into()));
        }
        self.services.insert(name, service);
        Ok(self)
    }

    pub fn env(mut self, name: impl Into<String>, value: impl Into<String>) -> Result<Self> {
        let name = name.into();
        if self.services.contains_key(&name) || self.env.contains_key(&name) {
            return Err(Error::Configuration("duplicate binding".into()));
        }
        let value = value.into();
        self.env.insert(name, value);
        Ok(self)
    }
}
