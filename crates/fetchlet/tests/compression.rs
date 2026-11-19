#![cfg(all(
    feature = "compression",
    any(feature = "boa", feature = "quickjs", feature = "v8")
))]

//! Codecs behind `CompressionStream` and `DecompressionStream` belong to one
//! invocation and stay within the caller's budgets.

use serde_json::json;

use fetchlet::{App, Backend, Limits, Module};

const SOURCE: &str = r#"
const functions = globalThis.__fetchletClaimHost();
const host = (operation, input) => JSON.parse(functions.call(operation, JSON.stringify(input)));
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
      functions.putBytes(new Uint8Array(bytes)),
    ]);
    host("compression.finish", opened.value);
    let total = 0;
    for (;;) {
      const read = host("compression.read", opened.value);
      if (!read.ok) return [written.ok, read.error.code];
      if (read.value === null) return [written.ok, total];
      total += functions.takeBytes(read.value).length;
    }
  },
  // Input and output the guest leaves in the codec or the byte store.
  hoard() {
    let seed = 0x9e3779b9;
    const noise = new Uint8Array(300000).map(() => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed;
    });
    const code = (reply) => (reply.ok ? "ok" : reply.error.code);
    const unread = host("compression.open", ["deflate-raw", false]).value;
    const writes = [1, 2].map(() =>
      code(host("compression.write", [unread, functions.putBytes(noise)])),
    );
    const untaken = host("compression.open", ["deflate-raw", false]).value;
    host("compression.write", [untaken, functions.putBytes(noise)]);
    const reads = [1, 2].map(() => code(host("compression.read", untaken)));
    return [writes, reads];
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

/// A codec takes more input only after its output was read, and the byte
/// store holds at most one piece of output the guest did not take, so the
/// guest cannot hold host memory outside the budgets through a codec.
async fn hoarding(backend: Backend) -> anyhow::Result<()> {
    let mut app = App::builder(backend).module(Module::new(SOURCE)).build()?;
    assert_eq!(
        app.call_json("hoard", &[]).await?,
        json!([["ok", "INVALID_REQUEST"], ["ok", "INVALID_REQUEST"]])
    );
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn codecs_hold_only_what_the_guest_reads() -> anyhow::Result<()> {
    #[cfg(feature = "quickjs")]
    hoarding(Backend::quickjs()).await?;
    #[cfg(feature = "boa")]
    hoarding(Backend::boa()).await?;
    #[cfg(feature = "v8")]
    hoarding(Backend::v8()).await?;
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
