---
"@fetchlet-crates/fetchlet-web": patch
"@fetchlet/node": patch
---

`node:crypto` scrypt counts `p` toward `maxmem` and `Limits::scrypt_memory_bytes` as OpenSSL does, 128 * r * (N + p + 2) bytes, and rejects r * p of 2^30 or more; the host checks Node's key length bound, and derived keys and HMAC keys whose size the guest chooses fail instead of aborting when they cannot be allocated.
