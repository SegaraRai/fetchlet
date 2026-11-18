// node:crypto keys, signatures and ciphers against Node's own crypto, with
// the host's Web Crypto operations computed by a stand-in host.

import * as node from "node:crypto";

import { describe, expect, test } from "vite-plus/test";

import * as der from "../src/internal/crypto/der.ts";
import { installHost } from "./host.ts";

// fetchlet's Buffer is not Node's, so bytes compare by content.
const byteView = (value: Uint8Array) =>
  Buffer.from(value.buffer, value.byteOffset, value.byteLength);

expect.addEqualityTesters([
  (a: unknown, b: unknown) =>
    a instanceof Uint8Array && b instanceof Uint8Array
      ? byteView(a).equals(byteView(b))
      : undefined,
]);

installHost();

const crypto = (await import("@fetchlet/node/crypto")).default;

const rsa = node.generateKeyPairSync("rsa", { modulusLength: 1024 });
const ec = node.generateKeyPairSync("ec", { namedCurve: "P-256" });
const ed25519 = node.generateKeyPairSync("ed25519");
const x25519 = node.generateKeyPairSync("x25519");

const pem = (key: node.KeyObject, type: string) =>
  key.export({ format: "pem", type } as node.KeyExportOptions<"pem">) as string;

const derOf = (key: node.KeyObject, type: string) =>
  key.export({ format: "der", type } as node.KeyExportOptions<"der">);

describe("keys", () => {
  test.each([
    ["rsa", rsa, ["pkcs8", "pkcs1"], ["spki", "pkcs1"]],
    ["ec", ec, ["pkcs8", "sec1"], ["spki"]],
    ["ed25519", ed25519, ["pkcs8"], ["spki"]],
    ["x25519", x25519, ["pkcs8"], ["spki"]],
  ] as const)(
    "%s keys read and write each encoding as Node does",
    (_, pair, privateTypes, publicTypes) => {
      for (const type of privateTypes) {
        const key = crypto.createPrivateKey(pem(pair.privateKey, type));
        expect(key.type).toBe("private");
        expect(key.asymmetricKeyType).toBe(pair.privateKey.asymmetricKeyType);
        expect(key.asymmetricKeyDetails).toEqual(pair.privateKey.asymmetricKeyDetails);
        for (const output of privateTypes) {
          expect(
            key.export({
              format: "pem",
              type: output,
            }),
          ).toBe(pem(pair.privateKey, output));
        }
        const fromDer = crypto.createPrivateKey({
          key: derOf(pair.privateKey, type),
          format: "der",
          type,
        });
        expect(fromDer.equals(key)).toBe(true);
      }
      for (const type of publicTypes) {
        const key = crypto.createPublicKey(pem(pair.publicKey, type));
        expect(key.type).toBe("public");
        for (const output of publicTypes) {
          expect(key.export({ format: "pem", type: output })).toBe(pem(pair.publicKey, output));
          expect(
            Buffer.from(
              key.export({
                format: "der",
                type: output,
              }) as Uint8Array,
            ),
          ).toEqual(derOf(pair.publicKey, output));
        }
      }
      const derived = crypto.createPublicKey(
        crypto.createPrivateKey(pem(pair.privateKey, "pkcs8")),
      );
      expect(
        derived.export({
          format: "pem",
          type: "spki",
        }),
      ).toBe(pem(pair.publicKey, "spki"));
      expect(crypto.createPublicKey(pem(pair.privateKey, "pkcs8")).type).toBe("public");
    },
  );

  test("JWK imports and exports as Node does", () => {
    for (const pair of [rsa, ec, ed25519]) {
      const jwk = pair.privateKey.export({
        format: "jwk",
      });
      const key = crypto.createPrivateKey({
        key: jwk,
        format: "jwk",
      });
      expect(
        key.export({
          format: "jwk",
        }),
      ).toEqual(jwk);
      const publicJwk = pair.publicKey.export({
        format: "jwk",
      });
      expect(
        crypto
          .createPublicKey({
            key: jwk,
            format: "jwk",
          })
          .export({ format: "jwk" }),
      ).toEqual(publicJwk);
    }
  });

  test("secret keys", () => {
    const key = crypto.createSecretKey("secret", "utf8");
    expect(key.type).toBe("secret");
    expect(key.symmetricKeySize).toBe(6);
    expect((key.export() as Buffer).toString()).toBe("secret");
    expect(
      key.export({
        format: "jwk",
      }),
    ).toEqual(
      node.createSecretKey("secret", "utf8").export({
        format: "jwk",
      }),
    );
    expect(() =>
      key.export({
        format: "pem",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "ERR_INVALID_ARG_VALUE",
      }),
    );
    expect(key instanceof crypto.KeyObject).toBe(true);
    expect(
      crypto.generateKeySync("aes", {
        length: 256,
      }).symmetricKeySize,
    ).toBe(32);
  });

  test("a certificate yields its public key", () => {
    // The fields of an X.509 certificate up to its SubjectPublicKeyInfo.
    const spki = derOf(ed25519.publicKey, "spki");
    const name = der.sequence();
    const algorithm = der.sequence(der.oid("1.3.101.112"));
    const tbs = der.sequence(
      der.encode(0xa0, der.unsigned(new Uint8Array([2]))),
      der.unsigned(new Uint8Array([1])),
      algorithm,
      name,
      der.sequence(),
      name,
      spki,
    );
    const certificate = der.sequence(tbs, algorithm, der.bitString(new Uint8Array(64)));
    const text = `-----BEGIN CERTIFICATE-----
${Buffer.from(certificate).toString("base64")}
-----END CERTIFICATE-----
`;
    const key = crypto.createPublicKey(text);
    expect(key.asymmetricKeyType).toBe("ed25519");
    expect(
      key.export({
        format: "pem",
        type: "spki",
      }),
    ).toBe(pem(ed25519.publicKey, "spki"));
  });

  test("invalid input fails as Node does", () => {
    expect(() => crypto.createPrivateKey("garbage")).toThrow(
      expect.objectContaining({
        code: "ERR_OSSL_UNSUPPORTED",
      }),
    );
    expect(() =>
      crypto.createPublicKey(crypto.createPublicKey(pem(rsa.publicKey, "spki"))),
    ).toThrow("Invalid key object type public, expected private.");
    expect(() =>
      crypto.createPrivateKey(pem(rsa.privateKey, "pkcs8")).export({
        format: "pem",
        type: "sec1",
      }),
    ).toThrow("The selected key encoding sec1 can only be used for EC keys.");
  });

  test("generated key pairs work with Node", () => {
    const pair = crypto.generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
      publicKeyEncoding: {
        format: "pem",
        type: "spki",
      },
      privateKeyEncoding: {
        format: "pem",
        type: "pkcs8",
      },
    });
    const signature = node.sign("sha256", Buffer.from("data"), pair.privateKey as string);
    expect(node.verify("sha256", Buffer.from("data"), pair.publicKey as string, signature)).toBe(
      true,
    );
    const rsaPair = crypto.generateKeyPairSync("rsa", {
      modulusLength: 1024,
    });
    expect(rsaPair.privateKey.asymmetricKeyDetails).toEqual({
      modulusLength: 1024,
      publicExponent: 65537n,
    });
  });
});

describe("signatures", () => {
  const data = Buffer.from("fetchlet signs this");

  test("RSA PKCS #1 v1.5 signatures equal Node's", () => {
    for (const hash of ["sha1", "sha256", "RSA-SHA384", "sha512"]) {
      const ours = crypto.sign(hash, data, pem(rsa.privateKey, "pkcs1"));
      expect(ours).toEqual(node.sign(hash, data, rsa.privateKey));
      expect(crypto.verify(hash, data, pem(rsa.publicKey, "spki"), ours)).toBe(true);
      const signer = crypto.createSign(hash).update("fetchlet ").update("signs this");
      expect(
        signer.sign(
          rsa.privateKey.export({
            format: "pem",
            type: "pkcs8",
          }),
          "base64",
        ),
      ).toBe(ours.toString("base64"));
    }
    expect(
      crypto.verify(
        "sha256",
        Buffer.from("other"),
        pem(rsa.publicKey, "spki"),
        node.sign("sha256", data, rsa.privateKey),
      ),
    ).toBe(false);
  });

  test("RSA-PSS verifies with Node in both directions", () => {
    const padding = node.constants.RSA_PKCS1_PSS_PADDING;
    const privatePem = pem(rsa.privateKey, "pkcs8");
    const publicPem = pem(rsa.publicKey, "spki");
    for (const saltLength of [undefined, 32, node.constants.RSA_PSS_SALTLEN_DIGEST]) {
      const ours = crypto.sign("sha256", data, {
        key: privatePem,
        padding,
        saltLength,
      });
      expect(
        node.verify(
          "sha256",
          data,
          {
            key: rsa.publicKey,
            padding,
            saltLength,
          },
          ours,
        ),
      ).toBe(true);
      const theirs = node.sign("sha256", data, {
        key: rsa.privateKey,
        padding,
        saltLength,
      });
      expect(
        crypto.verify(
          "sha256",
          data,
          {
            key: publicPem,
            padding,
            saltLength,
          },
          theirs,
        ),
      ).toBe(true);
    }
  });

  test("ECDSA in DER and IEEE P1363 encodings verifies with Node", () => {
    const privatePem = pem(ec.privateKey, "sec1");
    const publicPem = pem(ec.publicKey, "spki");
    const der = crypto.sign("sha256", data, privatePem);
    expect(node.verify("sha256", data, ec.publicKey, der)).toBe(true);
    const p1363 = crypto.sign("sha384", data, { key: privatePem, dsaEncoding: "ieee-p1363" });
    expect(p1363.length).toBe(64);
    expect(
      node.verify(
        "sha384",
        data,
        {
          key: ec.publicKey,
          dsaEncoding: "ieee-p1363",
        },
        p1363,
      ),
    ).toBe(true);
    expect(crypto.verify("sha256", data, publicPem, node.sign("sha256", data, ec.privateKey))).toBe(
      true,
    );
    expect(crypto.verify("sha256", data, publicPem, Buffer.from("not DER"))).toBe(false);
    const verifier = crypto.createVerify("SHA256").update(data);
    expect(verifier.verify(publicPem, der)).toBe(true);
  });

  test("Ed25519 signatures equal Node's", () => {
    const ours = crypto.sign(null, data, pem(ed25519.privateKey, "pkcs8"));
    expect(ours).toEqual(node.sign(null, data, ed25519.privateKey));
    expect(crypto.verify(undefined, data, pem(ed25519.publicKey, "spki"), ours)).toBe(true);
  });

  test("the callback form and unsupported keys", async () => {
    const signature = await new Promise((resolve, reject) =>
      crypto.sign(null, data, pem(ed25519.privateKey, "pkcs8"), (error, value) =>
        error ? reject(error) : resolve(value),
      ),
    );
    expect(signature).toEqual(node.sign(null, data, ed25519.privateKey));
    expect(() => crypto.sign("sha256", data, pem(x25519.privateKey, "pkcs8"))).toThrow(
      expect.objectContaining({
        code: "ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE",
      }),
    );
    expect(() => crypto.createSign("nope")).toThrow(
      expect.objectContaining({
        code: "ERR_CRYPTO_INVALID_DIGEST",
      }),
    );
  });

  test("RSA-OAEP encrypts and decrypts with Node", () => {
    const secret = Buffer.from("secret message");
    const encrypted = crypto.publicEncrypt(pem(rsa.publicKey, "spki"), secret);
    expect(node.privateDecrypt(rsa.privateKey, encrypted)).toEqual(secret);
    const options = { oaepHash: "sha256", oaepLabel: Buffer.from("label") };
    const theirs = node.publicEncrypt(
      {
        key: rsa.publicKey,
        ...options,
      },
      secret,
    );
    expect(
      crypto.privateDecrypt(
        {
          key: pem(rsa.privateKey, "pkcs8"),
          ...options,
        },
        theirs,
      ),
    ).toEqual(secret);
    expect(() => crypto.privateDecrypt(pem(rsa.privateKey, "pkcs8"), Buffer.alloc(128))).toThrow(
      expect.objectContaining({
        code: "ERR_OSSL_RSA_OAEP_DECODING_ERROR",
      }),
    );
  });

  test("diffieHellman agrees with Node", () => {
    for (const [type, options] of [
      ["ec", { namedCurve: "P-384" }],
      ["x25519", {}],
    ] as const) {
      const other = node.generateKeyPairSync(type as "ec", options as { namedCurve: string });
      const mine = node.generateKeyPairSync(type as "ec", options as { namedCurve: string });
      const ours = crypto.diffieHellman({
        privateKey: crypto.createPrivateKey(pem(mine.privateKey, "pkcs8")),
        publicKey: crypto.createPublicKey(pem(other.publicKey, "spki")),
      });
      expect(ours).toEqual(
        node.diffieHellman({
          privateKey: other.privateKey,
          publicKey: mine.publicKey,
        }),
      );
    }
  });
});

describe("ciphers", () => {
  const plaintext = Buffer.from("fetchlet encrypts this message across several blocks of AES");
  const chunks = [plaintext.subarray(0, 5), plaintext.subarray(5, 21), plaintext.subarray(21)];

  test.each(["aes-128-cbc", "aes-192-cbc", "aes-256-cbc", "aes256", "aes-128-ctr", "aes-256-ctr"])(
    "%s matches Node chunk by chunk",
    (name) => {
      const info = node.getCipherInfo(name)!;
      const key = node.randomBytes(info.keyLength);
      const iv = node.randomBytes(16);
      const theirs = node.createCipheriv(name, key, iv);
      const ours = crypto.createCipheriv(name, key, iv);
      for (const chunk of chunks) {
        expect(ours.update(chunk)).toEqual(theirs.update(chunk));
      }
      expect(ours.final()).toEqual(theirs.final());
      const reference = node.createCipheriv(name, key, iv);
      const full = Buffer.concat([reference.update(plaintext), reference.final()]);
      const decipher = crypto.createDecipheriv(name, key, iv);
      const expected = node.createDecipheriv(name, key, iv);
      for (const part of [full.subarray(0, 7), full.subarray(7, 40), full.subarray(40)]) {
        expect(decipher.update(part)).toEqual(expected.update(part));
      }
      expect(decipher.final()).toEqual(expected.final());
    },
  );

  test("CBC without padding and with a bad final block", () => {
    const key = Buffer.alloc(16, 1);
    const iv = Buffer.alloc(16, 2);
    const blocks = Buffer.alloc(32, 0x11);
    const ours = crypto.createCipheriv("aes-128-cbc", key, iv).setAutoPadding(false);
    const theirs = node.createCipheriv("aes-128-cbc", key, iv).setAutoPadding(false);
    const encrypted = Buffer.concat([ours.update(blocks), ours.final()]);
    expect(encrypted).toEqual(Buffer.concat([theirs.update(blocks), theirs.final()]));
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv).setAutoPadding(false);
    expect(Buffer.concat([decipher.update(encrypted), decipher.final()])).toEqual(blocks);
    const padded = crypto.createDecipheriv("aes-128-cbc", key, iv);
    padded.update(encrypted);
    expect(() => padded.final()).toThrow(
      expect.objectContaining({
        code: "ERR_OSSL_BAD_DECRYPT",
      }),
    );
    const partial = crypto.createCipheriv("aes-128-cbc", key, iv).setAutoPadding(false);
    partial.update(Buffer.alloc(5));
    expect(() => partial.final()).toThrow(
      expect.objectContaining({
        code: "ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH",
      }),
    );
  });

  test("GCM matches Node with AAD and short tags", () => {
    const key = node.randomBytes(32);
    const iv = node.randomBytes(12);
    const aad = Buffer.from("header");
    for (const authTagLength of [16, 12]) {
      const theirs = node
        .createCipheriv("aes-256-gcm", key, iv, {
          authTagLength,
        })
        .setAAD(aad);
      const expected = Buffer.concat([theirs.update(plaintext), theirs.final()]);
      const ours = crypto
        .createCipheriv("aes-256-gcm", key, iv, {
          authTagLength,
        })
        .setAAD(aad);
      const encrypted = Buffer.concat([...chunks.map((chunk) => ours.update(chunk)), ours.final()]);
      expect(encrypted).toEqual(expected);
      expect(ours.getAuthTag()).toEqual(theirs.getAuthTag());
      const decipher = crypto
        .createDecipheriv("aes-256-gcm", key, iv, {
          authTagLength,
        })
        .setAAD(aad)
        .setAuthTag(theirs.getAuthTag());
      expect(Buffer.concat([decipher.update(encrypted), decipher.final()])).toEqual(plaintext);
    }
    const tampered = crypto.createDecipheriv("aes-256-gcm", key, iv).setAuthTag(Buffer.alloc(16));
    tampered.update(plaintext);
    expect(() => tampered.final()).toThrow("Unsupported state or unable to authenticate data");
  });

  test("string encodings and KeyObject keys", () => {
    const key = crypto.createSecretKey(Buffer.alloc(16, 7));
    const iv = Buffer.alloc(16, 9);
    const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
    const hex = cipher.update("hello", "utf8", "hex") + cipher.final("hex");
    const reference = node.createCipheriv("aes-128-cbc", Buffer.alloc(16, 7), iv);
    expect(hex).toBe(reference.update("hello", "utf8", "hex") + reference.final("hex"));
  });

  test("argument errors match Node", () => {
    expect(() => crypto.createCipheriv("des", Buffer.alloc(8), Buffer.alloc(8))).toThrow(
      expect.objectContaining({
        code: "ERR_CRYPTO_UNKNOWN_CIPHER",
      }),
    );
    expect(() => crypto.createCipheriv("aes-128-cbc", Buffer.alloc(15), Buffer.alloc(16))).toThrow(
      expect.objectContaining({
        code: "ERR_CRYPTO_INVALID_KEYLEN",
        name: "RangeError",
      }),
    );
    expect(() => crypto.createCipheriv("aes-128-cbc", Buffer.alloc(16), Buffer.alloc(15))).toThrow(
      expect.objectContaining({
        code: "ERR_CRYPTO_INVALID_IV",
        name: "TypeError",
      }),
    );
    expect(crypto.getCiphers()).toContain("aes-256-gcm");
    expect(crypto.getCiphers().every((name) => node.getCiphers().includes(name))).toBe(true);
    expect(crypto.getCipherInfo("aes-128-gcm")).toMatchObject({
      keyLength: 16,
      ivLength: 12,
    });
  });
});
