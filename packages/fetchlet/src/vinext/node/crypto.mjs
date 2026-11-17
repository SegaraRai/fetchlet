// node:crypto for the vinext server: the synchronous SHA-256 hash it uses for
// cache keys, from @noble/hashes.
import { sha256 } from "@noble/hashes/sha2.js";
import { Buffer } from "./buffer.mjs";

export function createHash(algorithm) {
  if (String(algorithm).toLowerCase() !== "sha256") {
    throw new Error("createHash(" + JSON.stringify(algorithm) + ") is not available in fetchlet");
  }
  const hash = sha256.create();
  return {
    update(data, encoding) {
      hash.update(typeof data === "string" ? Buffer.from(data, encoding) : data);
      return this;
    },
    digest(encoding) {
      const bytes = Buffer.from(hash.digest());
      return encoding ? bytes.toString(encoding) : bytes;
    },
  };
}

export default { createHash };
