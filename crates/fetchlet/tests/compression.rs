#![cfg(any(feature = "boa", feature = "quickjs", feature = "v8"))]

//! Codecs behind `CompressionStream` and `DecompressionStream` belong to one
//! invocation and stay within the caller's budgets.

use serde_json::json;

use fetchlet::{App, Backend, Limits, Module};

const SOURCE: &str = r#"
const host = (operation, input) => JSON.parse(globalThis.__fetchletHost(operation, JSON.stringify(input)));
let previous;
globalThis.fetchletExports = {
  open(count) {
    const replies = [];
    for (let index = 0; index < count; index++) {
      replies.push(host("compression.open", ["gzip", false]));
    }
    previous = replies[0].value;
    return replies.map((reply) => (reply.ok ? "ok" : reply.error.code));
  },
  // A codec id from an earlier invocation names nothing in this one.
  reuse: () => host("compression.finish", previous).ok,
  inflate(bytes) {
    const opened = host("compression.open", ["gzip", true]);
    const written = host("compression.write", [
      opened.value,
      globalThis.__fetchletPutBytes(new Uint8Array(bytes)),
    ]);
    host("compression.finish", opened.value);
    let total = 0;
    for (;;) {
      const read = host("compression.read", opened.value);
      if (!read.ok) return [written.ok, read.error.code];
      if (read.value === null) return [written.ok, total];
      total += globalThis.__fetchletTakeBytes(read.value).length;
    }
  },
};
"#;

fn gzip_of_zeros(length: usize) -> Vec<u8> {
    use std::io::Write;
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    encoder.write_all(&vec![0; length]).unwrap();
    encoder.finish().unwrap()
}

async fn budgets(backend: Backend) -> anyhow::Result<()> {
    let mut app = App::builder(backend)
        .module(Module::new(SOURCE))
        .limits(Limits {
            compression_streams: Some(2),
            decompressed_bytes: Some(1024),
            ..Limits::default()
        })
        .build()?;
    assert_eq!(
        app.call_json("open", &[json!(3)]).await?,
        json!(["ok", "ok", "LIMIT_EXCEEDED"])
    );
    // The previous invocation's codecs were dropped with it.
    assert_eq!(app.call_json("reuse", &[]).await?, json!(false));
    assert_eq!(
        app.call_json("open", &[json!(2)]).await?,
        json!(["ok", "ok"])
    );
    assert_eq!(
        app.call_json("inflate", &[json!(gzip_of_zeros(1024))])
            .await?,
        json!([true, 1024])
    );
    assert_eq!(
        app.call_json("inflate", &[json!(gzip_of_zeros(1 << 20))])
            .await?,
        json!([true, "LIMIT_EXCEEDED"])
    );
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn codecs_are_scoped_and_budgeted() -> anyhow::Result<()> {
    #[cfg(feature = "quickjs")]
    budgets(Backend::quickjs()).await?;
    #[cfg(feature = "boa")]
    budgets(Backend::boa()).await?;
    #[cfg(feature = "v8")]
    budgets(Backend::v8()).await?;
    Ok(())
}
