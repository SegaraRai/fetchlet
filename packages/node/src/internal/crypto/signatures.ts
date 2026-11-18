// node:crypto signatures, RSA encryption and Diffie-Hellman over the host's
// Web Crypto operations: RSASSA-PKCS1-v1_5 and RSA-PSS, ECDSA with Node's
// DER or IEEE P1363 encoding, Ed25519, RSA-OAEP, ECDH and X25519.

import { Buffer } from "../buffer/buffer.ts";
import { invalidArgType, invalidArgValue, nodeError, validateFunction } from "../errors/errors.ts";
import {
  base64,
  type BinaryLike,
  callLater,
  concat,
  encode,
  type Encoding,
  fromBase64,
  hashLengths,
  hashName,
  type NodeBuffer,
  toBytes,
  WebCryptoFailure,
  webCryptoHost,
  webHashes,
} from "./common.ts";
import * as der from "./der.ts";
import { type AsymmetricKey, keyAlgorithm, prepareAsymmetricKey } from "./keys.ts";

export const constants = {
  RSA_PKCS1_PADDING: 1,
  RSA_NO_PADDING: 3,
  RSA_PKCS1_OAEP_PADDING: 4,
  RSA_PKCS1_PSS_PADDING: 6,
  RSA_PSS_SALTLEN_DIGEST: -1,
  RSA_PSS_SALTLEN_MAX_SIGN: -2,
  RSA_PSS_SALTLEN_AUTO: -2,
  POINT_CONVERSION_COMPRESSED: 2,
  POINT_CONVERSION_UNCOMPRESSED: 4,
  POINT_CONVERSION_HYBRID: 6,
};

const unsupportedForKey = () =>
  nodeError(
    Error,
    "ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE",
    "error:03000096:digital envelope routines::operation not supported for this keytype",
  );

/** Node's hash name, defaulting to SHA-256, and its Web Crypto name. */
function signatureHash(algorithm: unknown): { name: string; web: string } {
  if (algorithm === null || algorithm === undefined) {
    return { name: "sha256", web: "SHA-256" };
  }
  if (typeof algorithm !== "string") {
    throw invalidArgType("algorithm", "of type string", algorithm);
  }
  const name = hashName(algorithm);
  if (!name) {
    throw nodeError(TypeError, "ERR_CRYPTO_INVALID_DIGEST", `Invalid digest: ${algorithm}`);
  }
  const web = webHashes[name];
  if (!web) {
    throw nodeError(
      Error,
      "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
      `Signatures with ${name} are not available in fetchlet`,
    );
  }
  return { name, web };
}

function keyMessage(key: AsymmetricKey) {
  return {
    type: key.type,
    data: base64(key.data),
  };
}

/** The byte length of each coordinate and scalar of a curve. */
const curveBytes: Record<string, number> = {
  "P-256": 32,
  "P-384": 48,
  "P-521": 66,
};

/** An ECDSA signature r || s as a DER SEQUENCE of two INTEGERs. */
function p1363ToDer(signature: Uint8Array): Uint8Array {
  const half = signature.byteLength / 2;
  return der.sequence(
    der.unsigned(signature.subarray(0, half)),
    der.unsigned(signature.subarray(half)),
  );
}

/** A DER ECDSA signature as r || s, or undefined when it is malformed. */
function derToP1363(signature: Uint8Array, size: number): Uint8Array | undefined {
  try {
    const parts = der.children(der.parse(signature)).map((part) => der.readUnsigned(part));
    if (parts.length !== 2 || parts.some((part) => part.byteLength > size)) {
      return undefined;
    }
    const result = new Uint8Array(size * 2);
    result.set(parts[0], size - parts[0].byteLength);
    result.set(parts[1], size * 2 - parts[1].byteLength);
    return result;
  } catch {
    return undefined;
  }
}

/** The largest PSS salt for a key and hash, which Node signs with by default. */
function maxSaltLength(key: AsymmetricKey, hash: string): number {
  return Math.ceil((key.modulusLength! - 1) / 8) - hashLengths[hash] - 2;
}

interface SignatureRequest {
  algorithm: Record<string, unknown>;
  keyAlgorithm: Record<string, unknown>;
}

function signatureRequests(
  key: AsymmetricKey,
  algorithm: unknown,
  options: Record<string, unknown>,
  verifying: boolean,
): SignatureRequest[] {
  switch (key.keyType) {
    case "rsa": {
      const hash = signatureHash(algorithm);
      const padding = options.padding ?? constants.RSA_PKCS1_PADDING;
      if (padding === constants.RSA_PKCS1_PADDING) {
        const name = "RSASSA-PKCS1-v1_5";
        return [{ algorithm: { name }, keyAlgorithm: keyAlgorithm(key, name, hash.web) }];
      }
      if (padding !== constants.RSA_PKCS1_PSS_PADDING) {
        throw invalidArgValue("options.padding", padding);
      }
      const name = "RSA-PSS";
      const saltLength = options.saltLength ?? constants.RSA_PSS_SALTLEN_MAX_SIGN;
      const lengths =
        saltLength === constants.RSA_PSS_SALTLEN_DIGEST
          ? [hashLengths[hash.name]]
          : saltLength === constants.RSA_PSS_SALTLEN_MAX_SIGN
            ? // Verifying recovers the salt length; the host checks one at a time.
              verifying
              ? [maxSaltLength(key, hash.name), hashLengths[hash.name], 0]
              : [maxSaltLength(key, hash.name)]
            : [saltLength as number];
      return lengths.map((length) => ({
        algorithm: { name, saltLength: length },
        keyAlgorithm: keyAlgorithm(key, name, hash.web),
      }));
    }
    case "ec": {
      const hash = signatureHash(algorithm);
      return [
        {
          algorithm: { name: "ECDSA", hash: hash.web },
          keyAlgorithm: keyAlgorithm(key, "ECDSA"),
        },
      ];
    }
    case "ed25519":
      return [{ algorithm: { name: "Ed25519" }, keyAlgorithm: keyAlgorithm(key) }];
    default:
      throw unsupportedForKey();
  }
}

function dsaEncoding(options: Record<string, unknown>): "der" | "ieee-p1363" {
  const encoding = options.dsaEncoding ?? "der";
  if (encoding !== "der" && encoding !== "ieee-p1363") {
    throw invalidArgValue("options.dsaEncoding", encoding);
  }
  return encoding;
}

function signBytes(algorithm: unknown, data: Uint8Array, privateKey: unknown): NodeBuffer {
  const { key, options } = prepareAsymmetricKey(privateKey, "private");
  if (key.type !== "private") {
    throw nodeError(
      TypeError,
      "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE",
      "Invalid key object type public, expected private.",
    );
  }
  const [request] = signatureRequests(key, algorithm, options, false);
  const encoding = key.keyType === "ec" ? dsaEncoding(options) : "der";
  let signature: NodeBuffer;
  try {
    signature = fromBase64(
      webCryptoHost("crypto.sign", {
        ...request,
        key: keyMessage(key),
        data: base64(data),
      }) as string,
    );
  } catch (error) {
    if (error instanceof WebCryptoFailure) {
      throw nodeError(Error, "ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED", error.message);
    }
    throw error;
  }
  return key.keyType === "ec" && encoding === "der"
    ? Buffer.from(p1363ToDer(signature))
    : signature;
}

function verifyBytes(
  algorithm: unknown,
  data: Uint8Array,
  publicKey: unknown,
  signature: Uint8Array,
): boolean {
  const { key, options } = prepareAsymmetricKey(publicKey, "public");
  const requests = signatureRequests(key, algorithm, options, true);
  let bytes: Uint8Array | undefined = signature;
  if (key.keyType === "ec" && dsaEncoding(options) === "der") {
    bytes = derToP1363(signature, curveBytes[key.curve!]);
  }
  if (!bytes) {
    return false;
  }
  for (const request of requests) {
    try {
      const verified = webCryptoHost("crypto.verify", {
        ...request,
        key: keyMessage(key),
        data: base64(data),
        signature: base64(bytes),
      });
      if (verified === true) {
        return true;
      }
    } catch (error) {
      if (!(error instanceof WebCryptoFailure)) {
        throw error;
      }
    }
  }
  return false;
}

function binary(value: unknown, name: string): Uint8Array {
  if (typeof value !== "string" && !ArrayBuffer.isView(value)) {
    throw invalidArgType(name, "an instance of Buffer, TypedArray, or DataView", value);
  }
  return toBytes(value, name);
}

export function sign(
  algorithm: string | null | undefined,
  data: ArrayBufferView,
  key: unknown,
): NodeBuffer;
export function sign(
  algorithm: string | null | undefined,
  data: ArrayBufferView,
  key: unknown,
  callback: (error: Error | null, signature?: NodeBuffer) => void,
): void;
export function sign(
  algorithm: string | null | undefined,
  data: ArrayBufferView,
  key: unknown,
  callback?: (error: Error | null, signature?: NodeBuffer) => void,
): NodeBuffer | void {
  const bytes = binary(data, "data");
  if (callback !== undefined) {
    validateFunction(callback, "callback");
    callLater(callback, () => [signBytes(algorithm, bytes, key)] as [NodeBuffer]);
    return;
  }
  return signBytes(algorithm, bytes, key);
}

export function verify(
  algorithm: string | null | undefined,
  data: ArrayBufferView,
  key: unknown,
  signature: ArrayBufferView,
  callback?: (error: Error | null, verified?: boolean) => void,
): boolean | void {
  const bytes = binary(data, "data");
  const signatureBytes = binary(signature, "signature");
  if (callback !== undefined) {
    validateFunction(callback, "callback");
    callLater(callback, () => [verifyBytes(algorithm, bytes, key, signatureBytes)] as [boolean]);
    return;
  }
  return verifyBytes(algorithm, bytes, key, signatureBytes);
}

class SignatureInput {
  protected readonly algorithm: string;
  protected chunks: Uint8Array[] = [];

  constructor(algorithm: string) {
    if (typeof algorithm !== "string") {
      throw invalidArgType("algorithm", "of type string", algorithm);
    }
    if (!hashName(algorithm)) {
      throw nodeError(TypeError, "ERR_CRYPTO_INVALID_DIGEST", "Invalid digest");
    }
    this.algorithm = algorithm;
  }

  update(data: BinaryLike, inputEncoding?: Encoding): this {
    this.chunks.push(toBytes(data, "data", inputEncoding).slice());
    return this;
  }
}

export class Sign extends SignatureInput {
  sign(privateKey: unknown, outputEncoding?: Encoding): NodeBuffer | string {
    return encode(signBytes(this.algorithm, concat(this.chunks), privateKey), outputEncoding);
  }
}

export class Verify extends SignatureInput {
  verify(object: unknown, signature: BinaryLike, signatureEncoding?: Encoding): boolean {
    return verifyBytes(
      this.algorithm,
      concat(this.chunks),
      object,
      toBytes(signature, "signature", signatureEncoding),
    );
  }
}

export function createSign(algorithm: string, _options?: object): Sign {
  return new Sign(algorithm);
}

export function createVerify(algorithm: string, _options?: object): Verify {
  return new Verify(algorithm);
}

// RSA encryption

function oaep(key: unknown, wanted: "public" | "private", data: unknown, encrypt: boolean) {
  const prepared = prepareAsymmetricKey(key, wanted);
  const { options } = prepared;
  const bytes = toBytes(data, "buffer", options.encoding as string | undefined);
  if (prepared.key.keyType !== "rsa") {
    throw unsupportedForKey();
  }
  const padding = options.padding ?? constants.RSA_PKCS1_OAEP_PADDING;
  if (padding !== constants.RSA_PKCS1_OAEP_PADDING) {
    throw nodeError(
      Error,
      "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
      "RSA encryption without OAEP padding is not available in fetchlet",
    );
  }
  const hash = signatureHash(options.oaepHash ?? "sha1");
  const algorithm: Record<string, unknown> = { name: "RSA-OAEP" };
  if (options.oaepLabel !== undefined) {
    algorithm.label = base64(toBytes(options.oaepLabel, "options.oaepLabel"));
  }
  try {
    return fromBase64(
      webCryptoHost(encrypt ? "crypto.encrypt" : "crypto.decrypt", {
        algorithm,
        keyAlgorithm: keyAlgorithm(prepared.key, "RSA-OAEP", hash.web),
        key: keyMessage(prepared.key),
        data: base64(bytes),
      }) as string,
    );
  } catch (error) {
    if (error instanceof WebCryptoFailure) {
      throw encrypt
        ? nodeError(
            Error,
            "ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_KEY_SIZE",
            "error:0200006E:rsa routines::data too large for key size",
          )
        : nodeError(
            Error,
            "ERR_OSSL_RSA_OAEP_DECODING_ERROR",
            "error:02000079:rsa routines::oaep decoding error",
          );
    }
    throw error;
  }
}

export function publicEncrypt(key: unknown, buffer: BinaryLike): NodeBuffer {
  return oaep(key, "public", buffer, true);
}

export function privateDecrypt(key: unknown, buffer: BinaryLike): NodeBuffer {
  return oaep(key, "private", buffer, false);
}

const rawRsaUnavailable = (name: string) => () => {
  throw nodeError(
    Error,
    "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
    `crypto.${name} is not available in fetchlet`,
  );
};

export const privateEncrypt = rawRsaUnavailable("privateEncrypt");
export const publicDecrypt = rawRsaUnavailable("publicDecrypt");

// Diffie-Hellman

export function diffieHellman(options: { privateKey: unknown; publicKey: unknown }): NodeBuffer {
  if (options === null || typeof options !== "object") {
    throw invalidArgType("options", "of type object", options);
  }
  const { key: privateKey } = prepareAsymmetricKey(options.privateKey, "private");
  const { key: publicKey } = prepareAsymmetricKey(options.publicKey, "public");
  if (
    privateKey.keyType !== publicKey.keyType ||
    privateKey.curve !== publicKey.curve ||
    (privateKey.keyType !== "ec" && privateKey.keyType !== "x25519")
  ) {
    throw nodeError(
      Error,
      "ERR_CRYPTO_INCOMPATIBLE_KEY",
      "Incompatible key types for Diffie-Hellman: " +
        `${privateKey.keyType} and ${publicKey.keyType}`,
    );
  }
  const name = privateKey.keyType === "ec" ? "ECDH" : "X25519";
  return fromBase64(
    webCryptoHost("crypto.deriveBits", {
      algorithm: { name },
      keyAlgorithm: keyAlgorithm(privateKey, name),
      key: keyMessage(privateKey),
      public: keyMessage(publicKey),
    }) as string,
  );
}
