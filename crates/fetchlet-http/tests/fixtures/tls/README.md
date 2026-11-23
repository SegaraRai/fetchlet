# Test certificates

`ca.der` is a test certificate authority, and `server.der` with its PKCS #8
key `server.key.der` a server certificate it issued for `localhost` and
`127.0.0.1`, valid until 2126. `tests/sockets.rs` serves TLS with them and
trusts the authority. They protect nothing; regenerate them with OpenSSL
(an EC P-256 authority with `CA:TRUE` and `keyCertSign`, and a leaf with
`CA:FALSE`, `serverAuth` and those subject alternative names) if needed.
