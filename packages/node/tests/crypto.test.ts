// node:crypto against Node's own crypto, with the host operations computed
// by a stand-in host.

import * as node from "node:crypto";

import { describe, expect, test } from "vite-plus/test";

import { installHost } from "./host.ts";

const calls = installHost();
const crypto = (await import("@fetchlet/node/crypto")).default;

const algorithms = [
  "md5",
  "sha1",
  "sha224",
  "sha256",
  "sha384",
  "sha512",
  "sha512-224",
  "sha512-256",
  "SHA256",
  "RSA-SHA256",
  "sha-512",
];

describe("createHash", () => {
  test.each(algorithms)("%s matches Node across chunks and encodings", (algorithm) => {
    const ours = crypto
      .createHash(algorithm)
      .update("hello, ")
      .update(new Uint8Array([0xe2, 0x82, 0xac]));
    const theirs = node
      .createHash(algorithm)
      .update("hello, ")
      .update(new Uint8Array([0xe2, 0x82, 0xac]));
    expect(ours.copy().digest("hex")).toBe(theirs.copy().digest("hex"));
    expect(ours.copy().digest("base64url")).toBe(theirs.copy().digest("base64url"));
    expect([...ours.digest()]).toStrictEqual([...theirs.digest()]);
  });

  test("decodes input encodings like Node", () => {
    for (const encoding of ["hex", "base64", "latin1", "utf8"] as const) {
      const input = encoding === "hex" ? "deadbeef" : encoding === "base64" ? "3q2+7w==" : "café";
      expect(crypto.createHash("sha256").update(input, encoding).digest("hex")).toBe(
        node.createHash("sha256").update(input, encoding).digest("hex"),
      );
    }
  });

  test("hashes in the host", () => {
    calls.length = 0;
    crypto.createHash("sha1").update("x").digest();
    expect(calls).toStrictEqual(["nodeCrypto.hash"]);
  });

  test("refuses a second digest and unknown algorithms", () => {
    const hash = crypto.createHash("sha256");
    hash.digest();
    expect(() => hash.digest()).toThrow(
      expect.objectContaining({ code: "ERR_CRYPTO_HASH_FINALIZED" }),
    );
    expect(() => hash.update("x")).toThrow(
      expect.objectContaining({ code: "ERR_CRYPTO_HASH_FINALIZED" }),
    );
    expect(() => crypto.createHash("whirlpool")).toThrow("Digest method not supported");
  });

  test("one-shot hash", () => {
    expect(crypto.hash("sha1", "abc")).toBe(node.hash("sha1", "abc"));
    expect(crypto.hash("md5", "abc", "base64")).toBe(node.hash("md5", "abc", "base64"));
    expect((crypto.hash("sha256", "abc", "buffer") as Buffer).toString("hex")).toBe(
      node.hash("sha256", "abc", "hex"),
    );
  });

  test("getHashes lists the supported names, all known to Node", () => {
    expect(crypto.getHashes()).toHaveLength(8);
    expect(node.getHashes()).toEqual(expect.arrayContaining(crypto.getHashes()));
  });
});

describe("createHmac", () => {
  test.each(algorithms)("%s matches Node with short and long keys", (algorithm) => {
    for (const key of ["key", "k".repeat(200), new Uint8Array(0)]) {
      expect(crypto.createHmac(algorithm, key).update("message").digest("hex")).toBe(
        node.createHmac(algorithm, key).update("message").digest("hex"),
      );
    }
  });

  test("rejects unknown digests like Node", () => {
    expect(() => crypto.createHmac("nope", "key")).toThrow(
      expect.objectContaining({
        code: "ERR_CRYPTO_INVALID_DIGEST",
        message: "Invalid digest: nope",
      }),
    );
  });
});

describe("key derivation", () => {
  test("pbkdf2Sync and pbkdf2 match Node", async () => {
    for (const digest of ["sha1", "sha256", "sha512", "md5"]) {
      const expected = node.pbkdf2Sync("password", "salt", 3, 40, digest).toString("hex");
      expect(crypto.pbkdf2Sync("password", "salt", 3, 40, digest).toString("hex")).toBe(expected);
      const derived = await new Promise<Buffer>((resolve, reject) =>
        crypto.pbkdf2("password", "salt", 3, 40, digest, (error, key) =>
          error ? reject(error) : resolve(key),
        ),
      );
      expect(derived.toString("hex")).toBe(expected);
    }
  });

  test("pbkdf2 validates like Node", () => {
    expect(() => crypto.pbkdf2Sync("p", "s", 0, 10, "sha1")).toThrow(
      expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }),
    );
    expect(() => crypto.pbkdf2Sync("p", "s", 1, 10, "nope")).toThrow(
      expect.objectContaining({ code: "ERR_CRYPTO_INVALID_DIGEST" }),
    );
  });

  test("hkdfSync returns Node's ArrayBuffer", () => {
    const ours = crypto.hkdfSync("sha256", "ikm", "salt", "info", 64);
    expect(ours).toBeInstanceOf(ArrayBuffer);
    expect(Buffer.from(ours).toString("hex")).toBe(
      Buffer.from(node.hkdfSync("sha256", "ikm", "salt", "info", 64)).toString("hex"),
    );
    expect(() => crypto.hkdfSync("sha1", "ikm", "", "", 255 * 20 + 1)).toThrow(
      expect.objectContaining({ code: "ERR_CRYPTO_INVALID_KEYLEN" }),
    );
  });

  test("scryptSync and scrypt match Node", async () => {
    const options = { N: 1024, r: 8, p: 1 };
    const expected = node.scryptSync("password", "salt", 32, options).toString("hex");
    expect(crypto.scryptSync("password", "salt", 32, options).toString("hex")).toBe(expected);
    expect(crypto.scryptSync("password", "salt", 32, { cost: 1024 }).toString("hex")).toBe(
      expected,
    );
    const derived = await new Promise<Buffer>((resolve, reject) =>
      crypto.scrypt("password", "salt", 32, options, (error, key) =>
        error ? reject(error) : resolve(key),
      ),
    );
    expect(derived.toString("hex")).toBe(expected);
  });

  test("scrypt rejects parameters as Node does", () => {
    expect(() => crypto.scryptSync("p", "s", 16, { N: 3 })).toThrow(
      expect.objectContaining({ code: "ERR_CRYPTO_INVALID_SCRYPT_PARAMS" }),
    );
    expect(() => crypto.scryptSync("p", "s", 16, { N: 2 ** 20 })).toThrow(
      expect.objectContaining({ code: "ERR_CRYPTO_INVALID_SCRYPT_PARAMS" }),
    );
    expect(() => node.scryptSync("p", "s", 16, { N: 2 ** 20 })).toThrow(
      expect.objectContaining({ code: "ERR_CRYPTO_INVALID_SCRYPT_PARAMS" }),
    );
  });

  test("scrypt counts p toward maxmem as Node does", () => {
    // 128 * r * (N + p + 2) bytes: the blocks B and the table V.
    for (const options of [
      { N: 2, r: 1, p: 1000 },
      { N: 1024, r: 8, p: 16 },
    ]) {
      const exact = 128 * options.r * (options.N + options.p + 2);
      for (const maxmem of [exact, exact - 1]) {
        const run = (implementation: typeof node) => {
          try {
            implementation.scryptSync("p", "s", 16, {
              ...options,
              maxmem,
            });
            return "ok";
          } catch (error) {
            return (error as { code?: string }).code;
          }
        };
        expect(run(crypto as unknown as typeof node)).toBe(run(node));
      }
    }
  });
});

describe("random values", () => {
  test("randomBytes, randomFillSync and randomFill", async () => {
    expect(crypto.randomBytes(70_000)).toHaveLength(70_000);
    const filled = crypto.randomFillSync(new Uint8Array(8), 2, 4);
    expect([filled[0], filled[1], filled[6], filled[7]]).toStrictEqual([0, 0, 0, 0]);
    const viaCallback = await new Promise<Buffer>((resolve) =>
      crypto.randomBytes(16, (_error, bytes) => resolve(bytes)),
    );
    expect(viaCallback).toHaveLength(16);
    expect(() => crypto.randomBytes(-1)).toThrow(
      expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }),
    );
  });

  test("randomInt stays in range and validates like Node", () => {
    for (let index = 0; index < 1000; index += 1) {
      const value = crypto.randomInt(-3, 4) as number;
      expect(value).toBeGreaterThanOrEqual(-3);
      expect(value).toBeLessThan(4);
    }
    expect(crypto.randomInt(1)).toBe(0);
    expect(() => crypto.randomInt(2, 2)).toThrow(
      expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }),
    );
    expect(() => node.randomInt(2, 2)).toThrow(
      expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }),
    );
  });

  test("randomUUID and Web Crypto", () => {
    expect(crypto.randomUUID()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(crypto.webcrypto).toBe(globalThis.crypto);
    expect(crypto.subtle).toBe(globalThis.crypto.subtle);
  });
});

test("timingSafeEqual matches Node", () => {
  const a = Buffer.from("abc");
  expect(crypto.timingSafeEqual(a, Buffer.from("abc"))).toBe(true);
  expect(crypto.timingSafeEqual(a, Buffer.from("abd"))).toBe(false);
  expect(() => crypto.timingSafeEqual(a, Buffer.from("ab"))).toThrow(
    expect.objectContaining({ code: "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH", name: "RangeError" }),
  );
});

test("APIs outside the subset throw a clear error", () => {
  expect(() => crypto.privateEncrypt()).toThrow(
    "crypto.privateEncrypt is not available in fetchlet",
  );
});
