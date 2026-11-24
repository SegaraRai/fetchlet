#![cfg(feature = "boa")]

use serde_json::json;

use fetchlet::{App, Backend, BoaOptions, Error, Module};

const SOURCE: &str = r#"
globalThis.fetchletExports = {
  depth: (count) => {
    const descend = (remaining) => (remaining === 0 ? 0 : 1 + descend(remaining - 1));
    return descend(count);
  },
};
"#;

fn app(options: BoaOptions) -> fetchlet::Result<App> {
    App::builder(Backend::Boa(options))
        .module(Module::new(SOURCE))
        .build()
}

#[tokio::test(flavor = "current_thread")]
async fn recursion_limit_bounds_nested_calls() -> anyhow::Result<()> {
    let mut shallow = app(BoaOptions {
        recursion_limit: Some(64),
        ..BoaOptions::default()
    })?;
    assert_eq!(shallow.call_json("depth", &[json!(32)]).await?, json!(32));
    let error = shallow.call_json("depth", &[json!(200)]).await.unwrap_err();
    assert!(matches!(error, Error::JavaScript(_)), "{error}");

    // The engine default of 512 calls refuses what a raised limit allows.
    let mut default = app(BoaOptions::default())?;
    assert!(default.call_json("depth", &[json!(2000)]).await.is_err());
    let mut deep = app(BoaOptions {
        stack_size_limit: Some(1 << 20),
        recursion_limit: Some(4096),
        ..BoaOptions::default()
    })?;
    assert_eq!(deep.call_json("depth", &[json!(2000)]).await?, json!(2000));
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn loop_iteration_limit_stops_a_loop_that_never_yields() -> anyhow::Result<()> {
    let source = r#"
globalThis.fetchletExports = {
  count: (limit) => {
    let total = 0;
    for (let index = 0; index < limit; index += 1) total += 1;
    return total;
  },
  spin: () => {
    try {
      for (;;) {}
    } catch {
      return "caught";
    }
  },
};
"#;
    let mut app = App::builder(Backend::Boa(BoaOptions {
        loop_iteration_limit: Some(100_000),
        ..BoaOptions::default()
    }))
    .module(Module::new(source))
    .build()?;
    assert_eq!(app.call_json("count", &[json!(1000)]).await?, json!(1000));
    // The limit's error is not catchable, so the loop does not return.
    let error = app.call_json("spin", &[]).await.unwrap_err();
    assert!(matches!(error, Error::JavaScript(_)), "{error}");
    Ok(())
}

#[test]
fn zero_limits_are_rejected() {
    for options in [
        BoaOptions {
            stack_size_limit: Some(0),
            ..BoaOptions::default()
        },
        BoaOptions {
            recursion_limit: Some(0),
            ..BoaOptions::default()
        },
        BoaOptions {
            loop_iteration_limit: Some(0),
            ..BoaOptions::default()
        },
    ] {
        assert!(matches!(app(options), Err(Error::Configuration(_))));
    }
}
