---
"@fetchlet-crates/fetchlet": minor
"@fetchlet/web": minor
---

Stream outbound request bodies given as a `ReadableStream`, as Chrome and Firefox do. The transport reads each chunk as JavaScript produces it, within `request_body_bytes` and `request_body_chunks`, and the JavaScript stream is cancelled when the transport stops reading. Following the Fetch Standard, such a body needs `duplex: "half"`, cannot be combined with `keepalive` or a mode other than `cors` or `same-origin`, and fails the fetch on a redirect other than 303, which would resend it. `FetchService` marks the request with the new `RequireHttp2` extension so a network transport does not send it over HTTP/1.x, unless the policy allows it with `FetchPolicy::allow_http1_streaming()`. `FetchService::fetch` applies the same rules to a streaming `Body` from Rust instead of collecting it first. Bodies with a source, such as bytes, strings and Blobs, are still read first and resent on a redirect.
