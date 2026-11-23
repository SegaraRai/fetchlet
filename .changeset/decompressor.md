---
"@fetchlet-crates/fetchlet-web": minor
---

`Decompressor` and `CompressionFormat`, behind the `compression` feature, expose the streaming decoder of `DecompressionStream` to host code: gzip, zlib, raw deflate and Brotli, read in pieces of at most 64 KiB with an optional limit on the decompressed bytes.
