---
"@fetchlet-crates/fetchlet-net": minor
---

`HttpClient` sends a request marked `RequireHttp2`, such as a fetch whose body streams, only over an HTTP/2 connection, and fails it with `Transport` before sending anything on an HTTP/1.1 one, including any plain `http:` connection.
