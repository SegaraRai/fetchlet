//! The operating system's random source, which `getRandomValues` and key
//! generation share.

use super::message::{Failure, Outcome};

pub(super) fn fill(bytes: &mut [u8]) -> Outcome<()> {
    getrandom::fill(bytes).map_err(|_| Failure::operation("the random source is unavailable"))
}

pub(super) fn bytes<const N: usize>() -> Outcome<[u8; N]> {
    let mut bytes = [0; N];
    fill(&mut bytes)?;
    Ok(bytes)
}
