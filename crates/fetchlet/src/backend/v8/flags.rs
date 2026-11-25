//! V8's process-wide flags. V8 reads them once, when the first isolate
//! initializes it, so the first V8 instance that fetchlet starts in a
//! process decides them for every later one.

use std::sync::OnceLock;

use super::V8Options;

/// Whether the flag of [`V8Options::reliable_termination`] was set,
/// recorded when fetchlet first started a V8 instance.
static RELIABLE_TERMINATION: OnceLock<bool> = OnceLock::new();

/// Set the flags `options` need before V8 initializes, or check that the
/// flags already chosen satisfy them.
pub(super) fn initialize(options: &V8Options) -> crate::Result<()> {
    choose(&RELIABLE_TERMINATION, options.reliable_termination, || {
        // The first argument stands for the program name.
        deno_core::v8_set_flags(vec![String::new(), "--no-concurrent-osr".into()]);
    })
}

/// Record the first request in `chosen`, calling `set` if it asks for the
/// flag, and refuse a later request for the flag when the first did not.
fn choose(chosen: &OnceLock<bool>, requested: bool, set: impl FnOnce()) -> crate::Result<()> {
    let first = *chosen.get_or_init(|| {
        if requested {
            set();
        }
        requested
    });
    if requested && !first {
        return Err(crate::Error::Configuration(
            "V8Options::reliable_termination must be set on the first V8 instance of the process"
                .into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_instance_decides_the_flag() {
        let set = OnceLock::new();
        let mut calls = 0;
        choose(&set, true, || calls += 1).unwrap();
        choose(&set, false, || calls += 1).unwrap();
        choose(&set, true, || calls += 1).unwrap();
        assert_eq!(calls, 1);

        let unset = OnceLock::new();
        choose(&unset, false, || unreachable!()).unwrap();
        assert!(matches!(
            choose(&unset, true, || unreachable!()),
            Err(crate::Error::Configuration(_))
        ));
    }
}
