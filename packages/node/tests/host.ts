// A stand-in for the fetchlet host's nodeCrypto, crypto and compression
// operations, computed with Node's own crypto and zlib, so the modules can be
// compared with Node in Vitest. The host crate checks its operations against
// published vectors itself, and the runtime matrix runs the modules against
// the real host.

import * as crypto from "node:crypto";
import * as zlib from "node:zlib";

type Input = {
  algorithm: string;
  data: string;
  key: string;
  salt: string;
  info: string;
  iterations: number;
  length: number;
  cost: number;
  blockSize: number;
  parallelization: number;
  maxMemory: number;
};

const bytes = (value: string) => Buffer.from(value, "base64");

const operations: Partial<Record<string, (input: Input) => Buffer>> = {
  "nodeCrypto.hash": (input) =>
    crypto.createHash(input.algorithm).update(bytes(input.data)).digest(),
  "nodeCrypto.hmac": (input) =>
    crypto.createHmac(input.algorithm, bytes(input.key)).update(bytes(input.data)).digest(),
  "nodeCrypto.pbkdf2": (input) =>
    crypto.pbkdf2Sync(
      bytes(input.key),
      bytes(input.salt),
      input.iterations,
      input.length,
      input.algorithm,
    ),
  "nodeCrypto.hkdf": (input) =>
    Buffer.from(
      crypto.hkdfSync(
        input.algorithm,
        bytes(input.key),
        bytes(input.salt),
        bytes(input.info),
        input.length,
      ),
    ),
  "nodeCrypto.scrypt": (input) =>
    crypto.scryptSync(bytes(input.key), bytes(input.salt), input.length, {
      cost: input.cost,
      blockSize: input.blockSize,
      parallelization: input.parallelization,
      maxmem: input.maxMemory,
    }),
};

type Algorithm = {
  name: string;
  hash?: string;
  namedCurve?: string;
  saltLength?: number;
  label?: string;
  iv?: string;
  counter?: string;
  additionalData?: string;
  tagLength?: number;
  modulusLength?: number;
  publicExponent?: string;
};

type Key = {
  type: "secret" | "public" | "private";
  data: string;
};

type WebRequest = {
  algorithm: Algorithm;
  keyAlgorithm?: Algorithm;
  key?: Key;
  public?: Key;
  format?: string;
  data?: string;
  jwk?: crypto.JsonWebKey;
  signature?: string;
};

const nodeHash = (name = "SHA-256") => name.replace("-", "").toLowerCase();

function keyObject(key: Key): crypto.KeyObject {
  const data = bytes(key.data);
  if (key.type === "secret") {
    return crypto.createSecretKey(data);
  }
  return key.type === "public"
    ? crypto.createPublicKey({ key: data, format: "der", type: "spki" })
    : crypto.createPrivateKey({ key: data, format: "der", type: "pkcs8" });
}

function keyMessage(key: crypto.KeyObject): Key {
  const data =
    key.type === "public"
      ? key.export({ format: "der", type: "spki" })
      : key.export({ format: "der", type: "pkcs8" });
  return {
    type: key.type as Key["type"],
    data: data.toString("base64"),
  };
}

function properties(key: crypto.KeyObject) {
  const details = key.asymmetricKeyDetails!;
  if (key.asymmetricKeyType === "rsa") {
    const exponent = details.publicExponent!.toString(16);
    return {
      modulusLength: details.modulusLength,
      publicExponent: Buffer.from(exponent.length % 2 ? `0${exponent}` : exponent, "hex").toString(
        "base64",
      ),
    };
  }
  return key.asymmetricKeyType === "ec" ? { namedCurve: details.namedCurve } : {};
}

const keyTypes: Record<string, string> = {
  "RSASSA-PKCS1-v1_5": "rsa",
  "RSA-PSS": "rsa",
  "RSA-OAEP": "rsa",
  ECDSA: "ec",
  ECDH: "ec",
  Ed25519: "ed25519",
  X25519: "x25519",
};

/** AES as Web Crypto specifies it: CBC with PKCS #7 padding, CTR, and GCM with the tag appended. */
function aes(request: WebRequest, encrypt: boolean): Buffer {
  const { algorithm } = request;
  const key = bytes(request.key!.data);
  const data = bytes(request.data ?? "");
  const mode = algorithm.name.slice(4).toLowerCase();
  const name = `aes-${key.length * 8}-${mode}`;
  const iv = bytes(algorithm.iv ?? algorithm.counter ?? "");
  if (mode === "gcm") {
    const authTagLength = (algorithm.tagLength ?? 128) / 8;
    const aad = bytes(algorithm.additionalData ?? "");
    if (encrypt) {
      const cipher = crypto.createCipheriv(name as crypto.CipherGCMTypes, key, iv, {
        authTagLength,
      });
      cipher.setAAD(aad);
      return Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
    }
    const decipher = crypto.createDecipheriv(name as crypto.CipherGCMTypes, key, iv, {
      authTagLength,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(data.subarray(data.length - authTagLength));
    return Buffer.concat([
      decipher.update(data.subarray(0, data.length - authTagLength)),
      decipher.final(),
    ]);
  }
  const cipher = encrypt
    ? crypto.createCipheriv(name, key, iv)
    : crypto.createDecipheriv(name, key, iv);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function rsaOptions(request: WebRequest, key: crypto.KeyObject) {
  return {
    key,
    padding:
      request.algorithm.name === "RSA-PSS"
        ? crypto.constants.RSA_PKCS1_PSS_PADDING
        : crypto.constants.RSA_PKCS1_PADDING,
    saltLength: request.algorithm.saltLength,
  };
}

function oaepOptions(request: WebRequest) {
  return {
    key: keyObject(request.key!),
    oaepHash: nodeHash(request.keyAlgorithm!.hash),
    oaepLabel: request.algorithm.label ? bytes(request.algorithm.label) : undefined,
  };
}

const webOperations: Partial<Record<string, (request: WebRequest) => unknown>> = {
  "crypto.importKey": (request) => {
    let key: crypto.KeyObject;
    if (request.format === "jwk") {
      key = request.jwk!.d
        ? crypto.createPrivateKey({ key: request.jwk!, format: "jwk" })
        : crypto.createPublicKey({ key: request.jwk!, format: "jwk" });
    } else {
      key = keyObject({
        type: request.format === "spki" ? "public" : "private",
        data: request.data!,
      });
    }
    if (key.asymmetricKeyType !== keyTypes[request.algorithm.name]) {
      throw new Error("the key does not match the algorithm");
    }
    return { key: keyMessage(key), algorithm: properties(key) };
  },
  "crypto.exportKey": (request) => keyObject(request.key!).export({ format: "jwk" }),
  "crypto.generateKey": (request) => {
    const { algorithm } = request;
    let pair: crypto.KeyPairKeyObjectResult;
    if (algorithm.name === "Ed25519") {
      pair = crypto.generateKeyPairSync("ed25519");
    } else if (algorithm.name === "X25519") {
      pair = crypto.generateKeyPairSync("x25519");
    } else if (algorithm.namedCurve) {
      pair = crypto.generateKeyPairSync("ec", { namedCurve: algorithm.namedCurve });
    } else {
      pair = crypto.generateKeyPairSync("rsa", {
        modulusLength: algorithm.modulusLength!,
        publicExponent: parseInt(bytes(algorithm.publicExponent!).toString("hex"), 16),
      });
    }
    return {
      publicKey: keyMessage(pair.publicKey),
      privateKey: keyMessage(pair.privateKey),
      algorithm: properties(pair.publicKey),
    };
  },
  "crypto.sign": (request) => {
    const key = keyObject(request.key!);
    const data = bytes(request.data!);
    let signature: Buffer;
    if (request.algorithm.name === "Ed25519") {
      signature = crypto.sign(null, data, key);
    } else if (request.algorithm.name === "ECDSA") {
      signature = crypto.sign(nodeHash(request.algorithm.hash), data, {
        key,
        dsaEncoding: "ieee-p1363",
      });
    } else {
      signature = crypto.sign(nodeHash(request.keyAlgorithm!.hash), data, rsaOptions(request, key));
    }
    return signature.toString("base64");
  },
  "crypto.verify": (request) => {
    const key = keyObject(request.key!);
    const data = bytes(request.data!);
    const signature = bytes(request.signature!);
    if (request.algorithm.name === "Ed25519") {
      return crypto.verify(null, data, key, signature);
    }
    if (request.algorithm.name === "ECDSA") {
      return crypto.verify(
        nodeHash(request.algorithm.hash),
        data,
        { key, dsaEncoding: "ieee-p1363" },
        signature,
      );
    }
    return crypto.verify(
      nodeHash(request.keyAlgorithm!.hash),
      data,
      rsaOptions(request, key),
      signature,
    );
  },
  "crypto.encrypt": (request) =>
    (request.algorithm.name === "RSA-OAEP"
      ? crypto.publicEncrypt(oaepOptions(request), bytes(request.data!))
      : aes(request, true)
    ).toString("base64"),
  "crypto.decrypt": (request) =>
    (request.algorithm.name === "RSA-OAEP"
      ? crypto.privateDecrypt(oaepOptions(request), bytes(request.data!))
      : aes(request, false)
    ).toString("base64"),
  "crypto.deriveBits": (request) =>
    crypto
      .diffieHellman({
        privateKey: keyObject(request.key!),
        publicKey: keyObject(request.public!),
      })
      .toString("base64"),
};

// Compression codecs, with the byte handles the engines provide.

const handles = new Map<number, Uint8Array>();
let nextHandle = 0;

function putBytes(data: Uint8Array): number {
  nextHandle += 1;
  handles.set(nextHandle, data.slice());
  return nextHandle;
}

function takeBytes(handle: number): Uint8Array {
  const data = handles.get(handle)!;
  handles.delete(handle);
  return data;
}

interface Codec {
  format: string;
  decompress: boolean;
  input: Buffer[];
  output: Buffer[];
}

const codecs = new Map<number, Codec>();
let nextCodec = 0;

const codecFunctions: Record<string, [(data: Buffer) => Buffer, (data: Buffer) => Buffer]> = {
  gzip: [zlib.gzipSync, zlib.gunzipSync],
  deflate: [zlib.deflateSync, zlib.inflateSync],
  "deflate-raw": [zlib.deflateRawSync, zlib.inflateRawSync],
  brotli: [zlib.brotliCompressSync, zlib.brotliDecompressSync],
};

const compressionOperations: Partial<Record<string, (input: unknown) => unknown>> = {
  "compression.open": (input) => {
    const [format, decompress] = input as [string, boolean];
    nextCodec += 1;
    codecs.set(nextCodec, {
      format,
      decompress,
      input: [],
      output: [],
    });
    return nextCodec;
  },
  "compression.write": (input) => {
    const [id, handle] = input as [number, number];
    codecs.get(id)!.input.push(Buffer.from(takeBytes(handle)));
    return null;
  },
  "compression.finish": (input) => {
    const codec = codecs.get(input as number)!;
    const [compress, decompress] = codecFunctions[codec.format];
    const data = Buffer.concat(codec.input);
    codec.output.push((codec.decompress ? decompress : compress)(data));
    return null;
  },
  "compression.read": (input) => {
    const piece = codecs.get(input as number)!.output.shift();
    return piece ? putBytes(piece) : null;
  },
  "compression.close": (input) => {
    codecs.delete(input as number);
    return null;
  },
};

type Runtime = {
  __fetchletHost?: unknown;
  __fetchletPutBytes?: unknown;
  __fetchletTakeBytes?: unknown;
};

/** Installs the stand-in as globalThis.__fetchletHost and returns its operation log. */
export function installHost(): string[] {
  const calls: string[] = [];
  const runtime = globalThis as Runtime;
  runtime.__fetchletPutBytes = putBytes;
  runtime.__fetchletTakeBytes = takeBytes;
  runtime.__fetchletHost = (operation: string, input: string) => {
    calls.push(operation);
    const web = webOperations[operation];
    if (web) {
      try {
        return JSON.stringify({
          ok: true,
          value: {
            value: web(JSON.parse(input)),
          },
        });
      } catch (error) {
        return JSON.stringify({
          ok: true,
          value: {
            error: {
              name: "OperationError",
              message: (error as Error).message,
            },
          },
        });
      }
    }
    const compression = compressionOperations[operation];
    if (compression) {
      try {
        return JSON.stringify({
          ok: true,
          value: compression(JSON.parse(input)),
        });
      } catch (error) {
        return JSON.stringify({
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: (error as Error).message,
          },
        });
      }
    }
    const run = operations[operation];
    if (!run) {
      return JSON.stringify({
        ok: false,
        error: {
          code: "UnknownOperation",
          message: operation,
        },
      });
    }
    return JSON.stringify({
      ok: true,
      value: run(JSON.parse(input)).toString("base64"),
    });
  };
  return calls;
}
