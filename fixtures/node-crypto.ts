// node:crypto over the host's nodeCrypto operations. The runtime matrix
// compares the results with Node's own crypto; the Node reference has no
// fetchlet host and returns null.

import { Buffer } from "fetchlet/node/buffer";
import crypto from "fetchlet/node/crypto";

const hashes = ["md5", "sha1", "sha224", "sha256", "sha384", "sha512", "sha512-224", "sha512-256"];

export function nodeCryptoResults(): Record<string, unknown> | null {
  if (typeof (globalThis as { __fetchletHost?: unknown }).__fetchletHost !== "function") {
    return null;
  }
  return {
    hash: Object.fromEntries(
      hashes.map((name) => [
        name,
        crypto.createHash(name).update("fetchlet").update("é").digest("hex"),
      ]),
    ),
    hmac: Object.fromEntries(
      hashes.map((name) => [
        name,
        crypto.createHmac(name, "key").update("message").digest("base64"),
      ]),
    ),
    pbkdf2: crypto.pbkdf2Sync("password", "salt", 2, 40, "sha256").toString("hex"),
    hkdf: Buffer.from(crypto.hkdfSync("sha512", "ikm", "salt", "info", 80)).toString("hex"),
    scrypt: crypto.scryptSync("password", "salt", 32, { N: 1024, r: 8, p: 1 }).toString("hex"),
    timingSafeEqual: crypto.timingSafeEqual(Buffer.from("same"), Buffer.from("same")),
    randomBytes: crypto.randomBytes(100_000).length,
    randomUUID: /^[0-9a-f-]{36}$/.test(crypto.randomUUID()),
  };
}
