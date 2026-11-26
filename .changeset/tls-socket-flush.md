---
"@fetchlet-crates/fetchlet-net": patch
---

`TcpTransport` flushes each message JavaScript writes to a socket. Over TLS, bytes the connection could not take at once stayed buffered until the next write, so a request could wait for a reply that never came.
