import { describe, expect, test } from "vite-plus/test";

import {
  allowedUsages,
  blockBits,
  bufferSource,
  checkUsages,
  ecdsaJwkAlgorithm,
  enforceRange,
  jwkAlgorithm,
  jwkKeyType,
  jwkUse,
  normalizeAlgorithm,
  normalizeUsages,
  recognizeKeys,
  requireBufferSource,
} from "./algorithms.ts";

const domError = (name: string) => expect.objectContaining({ name });

describe("normalizeAlgorithm", () => {
  test("accepts a name in any case and returns its registered spelling", () => {
    expect(normalizeAlgorithm("sha-256", "digest")).toStrictEqual({
      name: "SHA-256",
    });
    expect(normalizeAlgorithm({ name: "aes-gcm", length: 128 }, "generateKey")).toStrictEqual({
      name: "AES-GCM",
      length: 128,
    });
  });

  test("converts members, normalizing nested hashes and copying bytes", () => {
    const iv = new Uint8Array([1, 2, 3]);
    const normalized = normalizeAlgorithm(
      {
        name: "AES-GCM",
        iv,
        tagLength: 128.9,
        ignored: true,
      },
      "encrypt",
    );
    expect(normalized).toStrictEqual({
      name: "AES-GCM",
      iv: new Uint8Array([1, 2, 3]),
      tagLength: 128,
    });
    iv[0] = 9;
    expect(normalized.iv[0]).toBe(1);
    expect(
      normalizeAlgorithm(
        {
          name: "HMAC",
          hash: "sha-512",
        },
        "importKey",
      ),
    ).toStrictEqual({
      name: "HMAC",
      hash: {
        name: "SHA-512",
      },
    });
  });

  test("verify, decrypt and unwrapKey share the registry of their counterparts", () => {
    expect(normalizeAlgorithm("Ed25519", "verify").name).toBe("Ed25519");
    expect(normalizeAlgorithm({ name: "AES-CBC", iv: new Uint8Array(16) }, "decrypt").name).toBe(
      "AES-CBC",
    );
    expect(normalizeAlgorithm("AES-KW", "unwrapKey").name).toBe("AES-KW");
  });

  test("an unknown algorithm or operation is NotSupportedError", () => {
    expect(() => normalizeAlgorithm("MD5", "digest")).toThrow(domError("NotSupportedError"));
    expect(() => normalizeAlgorithm("HKDF", "sign")).toThrow(
      expect.objectContaining({
        name: "NotSupportedError",
        message: "HKDF does not support sign",
      }),
    );
  });

  test("malformed algorithms are TypeErrors", () => {
    expect(() => normalizeAlgorithm(null, "digest")).toThrow(TypeError);
    expect(() => normalizeAlgorithm(1, "digest")).toThrow(TypeError);
    expect(() => normalizeAlgorithm({}, "digest")).toThrow("The algorithm has no name");
    expect(() => normalizeAlgorithm({ name: "AES-GCM" }, "encrypt")).toThrow(
      "The algorithm has no iv",
    );
    expect(() =>
      normalizeAlgorithm({ name: "AES-GCM", iv: new Uint8Array(12), tagLength: 256 }, "encrypt"),
    ).toThrow("The number is out of range");
    expect(() =>
      normalizeAlgorithm(
        {
          name: "RSA-PSS",
          modulusLength: 2048,
          publicExponent: [1, 0, 1],
          hash: "SHA-256",
        },
        "generateKey",
      ),
    ).toThrow("Expected a Uint8Array");
  });

  test("a public member must be a CryptoKey the key module recognizes", () => {
    const key = {};
    recognizeKeys((value) => value === key);
    expect(normalizeAlgorithm({ name: "ECDH", public: key }, "deriveBits").public).toBe(key);
    expect(() => normalizeAlgorithm({ name: "ECDH", public: {} }, "deriveBits")).toThrow(
      "Expected a CryptoKey",
    );
  });
});

describe("BufferSource conversion", () => {
  test("accepts buffers and views, and copies only the view's bytes", () => {
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    expect(requireBufferSource(buffer)).toBe(buffer);
    expect([...bufferSource(new DataView(buffer, 1, 2))]).toStrictEqual([2, 3]);
    expect([...bufferSource(buffer)]).toStrictEqual([1, 2, 3, 4]);
  });

  test("rejects other values and views of shared memory", () => {
    expect(() => requireBufferSource([1, 2])).toThrow("Expected a BufferSource");
    expect(() => requireBufferSource(new Uint8Array(new SharedArrayBuffer(4)))).toThrow(
      "Expected a BufferSource",
    );
  });
});

describe("enforceRange", () => {
  test("truncates in range and rejects the rest", () => {
    expect(enforceRange(3.9, 255)).toBe(3);
    expect(enforceRange("255", 255)).toBe(255);
    expect(() => enforceRange(256, 255)).toThrow("The number is out of range");
    expect(() => enforceRange(-1, 255)).toThrow("The number is out of range");
    expect(() => enforceRange(Number.NaN, 255)).toThrow("Expected a finite number");
    expect(() => enforceRange(Number.POSITIVE_INFINITY, 255)).toThrow("Expected a finite number");
  });
});

describe("key usages", () => {
  test("normalizeUsages removes duplicates in KeyUsage order", () => {
    expect(normalizeUsages(["verify", "sign", "verify", "encrypt"])).toStrictEqual([
      "encrypt",
      "sign",
      "verify",
    ]);
  });

  test("checkUsages throws SyntaxError for a usage the key type does not allow", () => {
    expect(() => checkUsages(["sign"], allowedUsages.ECDSA!.private!)).not.toThrow();
    expect(() => checkUsages(["sign"], allowedUsages.ECDSA!.public!)).toThrow(
      domError("SyntaxError"),
    );
    expect(() => checkUsages([], allowedUsages.ECDH!.public!)).not.toThrow();
  });
});

describe("JSON Web Key helpers", () => {
  test.each([
    [{ name: "AES-GCM", length: 256 }, "A256GCM"],
    [{ name: "AES-KW", length: 128 }, "A128KW"],
    [{ name: "HMAC", hash: { name: "SHA-384" } }, "HS384"],
    [{ name: "RSASSA-PKCS1-v1_5", hash: { name: "SHA-256" } }, "RS256"],
    [{ name: "RSA-PSS", hash: { name: "SHA-512" } }, "PS512"],
    [{ name: "RSA-OAEP", hash: { name: "SHA-1" } }, "RSA-OAEP"],
    [{ name: "RSA-OAEP", hash: { name: "SHA-256" } }, "RSA-OAEP-256"],
    [{ name: "Ed25519" }, "Ed25519"],
    [{ name: "ECDSA", namedCurve: "P-256" }, undefined],
  ])("jwkAlgorithm(%o) is %s", (algorithm, alg) => {
    expect(jwkAlgorithm(algorithm)).toBe(alg);
  });

  test("ECDSA import accepts the alg of its curve", () => {
    expect(ecdsaJwkAlgorithm("P-256")).toBe("ES256");
    expect(ecdsaJwkAlgorithm("P-521")).toBe("ES512");
    expect(ecdsaJwkAlgorithm("X25519")).toBeUndefined();
  });

  test("use and kty follow the algorithm family", () => {
    expect(["AES-CTR", "RSA-OAEP", "ECDH", "X25519"].map(jwkUse)).toStrictEqual([
      "enc",
      "enc",
      "enc",
      "enc",
    ]);
    expect(["HMAC", "ECDSA", "Ed25519", "RSA-PSS"].map(jwkUse)).toStrictEqual([
      "sig",
      "sig",
      "sig",
      "sig",
    ]);
    expect(
      ["AES-GCM", "HMAC", "RSA-PSS", "ECDSA", "ECDH", "Ed25519", "X25519"].map(jwkKeyType),
    ).toStrictEqual(["oct", "oct", "RSA", "EC", "EC", "OKP", "OKP"]);
  });

  test("HMAC's default key length is the hash block size", () => {
    expect(blockBits("SHA-1")).toBe(512);
    expect(blockBits("SHA-256")).toBe(512);
    expect(blockBits("SHA-384")).toBe(1024);
    expect(blockBits("SHA-512")).toBe(1024);
  });
});
