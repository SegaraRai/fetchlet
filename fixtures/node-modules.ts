// node:crypto keys, signatures and ciphers, node:zlib over the host, and the
// pure modules (stream, string_decoder, assert, url, querystring,
// diagnostics_channel, util/types) as each engine runs them. The runtime
// matrix compares the results with what Node computes for the same inputs;
// the Node reference has no fetchlet host and returns null.

import assert from "fetchlet/node/assert";
import { Buffer } from "fetchlet/node/buffer";
import crypto from "fetchlet/node/crypto";
import diagnostics from "fetchlet/node/diagnostics-channel";
import querystring from "fetchlet/node/querystring";
import { PassThrough, Readable, Transform, pipeline } from "fetchlet/node/stream";
import { StringDecoder } from "fetchlet/node/string-decoder";
import url from "fetchlet/node/url";
import types from "fetchlet/node/util/types";
import zlib from "fetchlet/node/zlib";

/** PKCS #8 for a curve25519 key from its 32-byte seed. */
function seedKey(oid: "70" | "6e", seed: number) {
  const prefix = `302e020100300506032b65${oid}04220420`;
  return crypto.createPrivateKey({
    key: Buffer.from(prefix + seed.toString(16).padStart(2, "0").repeat(32), "hex"),
    format: "der",
    type: "pkcs8",
  });
}

function cipherHex(name: string, keyLength: number, decrypt = false, input?: Uint8Array) {
  const key = Buffer.alloc(keyLength, 7);
  const iv = Buffer.alloc(name.endsWith("gcm") ? 12 : 16, 9);
  const plaintext = Buffer.from("fetchlet encrypts this across several AES blocks");
  const cipher = decrypt
    ? crypto.createDecipheriv(name, key, iv)
    : crypto.createCipheriv(name, key, iv);
  const data = input ?? plaintext;
  const output = [cipher.update(data.subarray(0, 5)), cipher.update(data.subarray(5))];
  return Buffer.concat([...output, cipher.final()]);
}

/** What the engines compute, compared in tools/matrix/runtime.ts with Node. */
export function nodeKeysResults(): Record<string, unknown> | null {
  if (typeof (globalThis as { __fetchletHost?: unknown }).__fetchletHost !== "function") {
    return null;
  }
  const data = Buffer.from("fetchlet signs this");
  const ed25519 = seedKey("70", 1);
  const ed25519Public = crypto.createPublicKey(ed25519);
  const x25519 = [seedKey("6e", 2), seedKey("6e", 3)];
  const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
  const rsaPem = rsa.privateKey.export({ format: "pem", type: "pkcs1" }) as string;
  const pss = { padding: crypto.constants.RSA_PKCS1_PSS_PADDING };
  const secret = Buffer.from("secret");
  const ciphers = Object.fromEntries(
    (
      [
        ["aes-128-cbc", 16],
        ["aes-192-cbc", 24],
        ["aes-256-ctr", 32],
      ] as const
    ).map(([name, length]) => {
      const encrypted = cipherHex(name, length);
      return [
        name,
        [encrypted.toString("hex"), cipherHex(name, length, true, encrypted).toString()],
      ];
    }),
  );
  const gcm = crypto.createCipheriv("aes-256-gcm", Buffer.alloc(32, 7), Buffer.alloc(12, 9));
  gcm.setAAD(Buffer.from("header"));
  const sealed = Buffer.concat([gcm.update("sealed"), gcm.final()]).toString("hex");
  return {
    ed25519: {
      signature: crypto.sign(null, data, ed25519).toString("hex"),
      publicKey: ed25519Public.export({ format: "pem", type: "spki" }),
      jwk: ed25519.export({ format: "jwk" }),
    },
    x25519: crypto
      .diffieHellman({
        privateKey: x25519[0],
        publicKey: crypto.createPublicKey(x25519[1]),
      })
      .toString("hex"),
    ecdsa: [
      crypto.verify("sha256", data, ec.publicKey, crypto.sign("sha256", data, ec.privateKey)),
      crypto.sign("sha384", data, { key: ec.privateKey, dsaEncoding: "ieee-p1363" }).length,
      ec.privateKey.asymmetricKeyDetails,
    ],
    rsa: [
      crypto.verify("sha256", data, rsa.publicKey, crypto.sign("sha256", data, rsaPem)),
      crypto.verify(
        "sha256",
        data,
        { key: rsa.publicKey, ...pss },
        crypto.sign("sha256", data, { key: rsa.privateKey, ...pss }),
      ),
      crypto.privateDecrypt(rsa.privateKey, crypto.publicEncrypt(rsa.publicKey, secret)).toString(),
      crypto.createPrivateKey(rsaPem).equals(rsa.privateKey),
      rsa.publicKey.asymmetricKeyDetails?.modulusLength,
    ],
    ciphers,
    gcm: [sealed, gcm.getAuthTag().toString("hex")],
  };
}

export async function nodeModulesResults(): Promise<Record<string, unknown> | null> {
  if (typeof (globalThis as { __fetchletHost?: unknown }).__fetchletHost !== "function") {
    return null;
  }
  const text = "fetchlet compresses this text ".repeat(4);
  const chunks: string[] = [];
  await new Promise<void>((resolve, reject) =>
    pipeline(
      Readable.from(["fetch", "let"]),
      new Transform({
        transform(
          chunk: unknown,
          _encoding: string,
          callback: (error: null, data: string) => void,
        ) {
          callback(null, String(chunk).toUpperCase());
        },
      }),
      new PassThrough().on("data", (chunk: unknown) => chunks.push(String(chunk))),
      (error: Error | null) => (error ? reject(error) : resolve()),
    ),
  );
  const web = Readable.toWeb(Readable.from([Buffer.from("to web")]));
  const decoder = new StringDecoder("utf8");
  const events: unknown[] = [];
  diagnostics.subscribe("fetchlet:matrix", (message: unknown) => events.push(message));
  diagnostics.channel("fetchlet:matrix").publish({ ok: true });
  const outcome = (run: () => void) => {
    try {
      run();
      return "pass";
    } catch (error) {
      return (error as { code?: string }).code;
    }
  };
  return {
    zlib: [
      zlib.gunzipSync(zlib.gzipSync(text)).toString() === text,
      zlib.inflateRawSync(zlib.deflateRawSync(text)).toString() === text,
      zlib.brotliDecompressSync(zlib.brotliCompressSync(text)).toString() === text,
      zlib
        .inflateSync(
          Buffer.from("eJxLSy1JzshJLVHIzEvLSSxJLVYoz0gsUfDLT0lVSEkFC6UAAP6IDZk=", "base64"),
        )
        .toString(),
      zlib.brotliDecompressSync(Buffer.from("iwOAZmV0Y2hsZXQD", "base64")).toString(),
      zlib.crc32("fetchlet"),
    ],
    stream: [chunks.join(""), await new Response(web).text()],
    stringDecoder: [
      decoder.write(Buffer.from([0xe2, 0x82])),
      decoder.write(Buffer.from([0xac])),
      decoder.end(Buffer.from([0xf0])),
    ],
    assert: [
      outcome(() =>
        assert.deepStrictEqual({ a: [1, new Map([[1, 2]])] }, { a: [1, new Map([[1, 2]])] }),
      ),
      outcome(() => assert.deepEqual([1], ["1"])),
      outcome(() => assert.strict.deepEqual([1], ["1"])),
      outcome(() =>
        assert.throws(() => {
          throw new TypeError("x");
        }, TypeError),
      ),
    ],
    url: [
      { ...url.parse("http://user@Example.com:8080/p/a?x=1&y=2#h", true) },
      url.format({ protocol: "https", hostname: "example.com", pathname: "/a", query: { q: "1" } }),
      url.resolve("http://example.com/a/b", "../c"),
      url.pathToFileURL("/tmp/a b#c").href,
      url.fileURLToPath("file:///tmp/a%20b"),
      url.domainToUnicode("xn--mnchen-3ya.de"),
    ],
    querystring: [
      { ...querystring.parse("a=1&a=2&b=%20c+d&bad=%zz") },
      querystring.stringify({ a: [1, "two"], b: true, c: "é&" }),
    ],
    diagnostics: events,
    utilTypes: [types.isPromise(Promise.resolve()), types.isUint8Array(Buffer.alloc(1))],
  };
}
