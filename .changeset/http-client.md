---
"@fetchlet-crates/fetchlet-net": minor
---

`HttpClient`, behind fetchlet-net's new `http` feature (on by default), sends JavaScript's outbound `fetch` requests as a `FetchTransport` over hyper: HTTP/1.1, and HTTP/2 when a TLS server selects it by ALPN, with connections pooled per origin and closed after `pool_idle_timeout` (90 seconds by default). Each new connection resolves its host and refuses non-public addresses unless `allow_private_addresses`, TLS verifies servers against the `webpki-roots` certificates or the configuration given to `with_tls_config`, redirects return to the caller, and response bodies stream as JavaScript reads them. As a browser does, it asks for `gzip, deflate, br` and undoes the codings a response's `Content-Encoding` lists as the body is read, in pieces of at most 64 KiB, then removes `Content-Encoding` and `Content-Length`; a request with its own `Accept-Encoding`, a `HEAD` request and an unknown coding keep the response as sent.
