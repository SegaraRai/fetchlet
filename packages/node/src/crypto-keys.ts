// node:crypto keys: KeyObject, createSecretKey, createPublicKey,
// createPrivateKey and key generation. Asymmetric keys are held as
// SubjectPublicKeyInfo or PKCS #8 DER, the forms the host's `crypto.*`
// operations take; PEM, PKCS #1, SEC 1, X.509 certificates and JWK convert
// to and from them here. The host validates each key as it is created.

import { Buffer } from "./buffer.ts";
import {
  type NodeBuffer,
  WebCryptoFailure,
  base64,
  callLater,
  fromBase64,
  isBinary,
  toBytes,
  webCryptoHost,
} from "./crypto-common.ts";
import * as der from "./der.ts";
import {
  invalidArgType,
  invalidArgValue,
  nodeError,
  validateFunction,
  validateInteger,
} from "./errors.ts";

export type AsymmetricKeyType = "rsa" | "ec" | "ed25519" | "x25519";
type KeyType = "secret" | "public" | "private";

const oids = {
  rsaEncryption: "1.2.840.113549.1.1.1",
  ecPublicKey: "1.2.840.10045.2.1",
  ed25519: "1.3.101.112",
  x25519: "1.3.101.110",
};

/** Curves by OID: the Web Crypto name and Node's name. */
const curves: Record<string, { web: string; node: string }> = {
  "1.2.840.10045.3.1.7": { web: "P-256", node: "prime256v1" },
  "1.3.132.0.34": { web: "P-384", node: "secp384r1" },
  "1.3.132.0.35": { web: "P-521", node: "secp521r1" },
};

const curveNames: Record<string, string> = {
  prime256v1: "P-256",
  secp256r1: "P-256",
  "p-256": "P-256",
  secp384r1: "P-384",
  "p-384": "P-384",
  secp521r1: "P-521",
  "p-521": "P-521",
};

export function getCurves(): string[] {
  return ["prime256v1", "secp384r1", "secp521r1"];
}

function curveOid(web: string): string {
  return Object.keys(curves).find((oid) => curves[oid].web === web)!;
}

/** The parts of an asymmetric key that operations need. */
export interface AsymmetricKey {
  type: "public" | "private";
  keyType: AsymmetricKeyType;
  /** SubjectPublicKeyInfo for public keys, PKCS #8 for private keys. */
  data: Uint8Array;
  /** The Web Crypto curve name of an EC key. */
  curve?: string;
  modulusLength?: number;
  publicExponent?: bigint;
}

const unsupportedKey = () =>
  nodeError(Error, "ERR_OSSL_UNSUPPORTED", "error:1E08010C:DECODER routines::unsupported");

const unavailable = (what: string) =>
  nodeError(Error, "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM", `${what} is not available in fetchlet`);

/** The Web Crypto algorithm that imports a key of this type. */
export function keyAlgorithm(
  key: Pick<AsymmetricKey, "keyType" | "curve">,
  name?: string,
  hash = "SHA-256",
): Record<string, unknown> {
  switch (key.keyType) {
    case "rsa":
      return { name: name ?? "RSASSA-PKCS1-v1_5", hash };
    case "ec":
      return { name: name ?? "ECDSA", namedCurve: key.curve };
    case "ed25519":
      return { name: "Ed25519" };
    case "x25519":
      return { name: "X25519" };
  }
}

/** The key type and curve that a DER key's AlgorithmIdentifier names. */
function identify(algorithm: der.Element): Pick<AsymmetricKey, "keyType" | "curve"> {
  const [id, parameters] = der.children(der.expect(algorithm, der.tags.sequence));
  const name = der.readOid(id);
  switch (name) {
    case oids.rsaEncryption:
      return { keyType: "rsa" };
    case oids.ed25519:
      return { keyType: "ed25519" };
    case oids.x25519:
      return { keyType: "x25519" };
    case oids.ecPublicKey: {
      const curve = parameters && curves[der.readOid(parameters)];
      if (!curve) {
        throw unavailable("This elliptic curve");
      }
      return { keyType: "ec", curve: curve.web };
    }
    default:
      throw unavailable(`The key algorithm ${name}`);
  }
}

/** Imports DER key material in the host, which validates it and reports its properties. */
function importDer(type: "public" | "private", data: Uint8Array): AsymmetricKey {
  let identity: Pick<AsymmetricKey, "keyType" | "curve">;
  try {
    const fields = der.children(der.parse(data));
    identity = identify(type === "public" ? fields[0] : fields[1]);
  } catch (error) {
    if (error instanceof der.DerError) {
      throw unsupportedKey();
    }
    throw error;
  }
  return importKey(identity, type === "public" ? "spki" : "pkcs8", { data: base64(data) });
}

function importKey(
  identity: Pick<AsymmetricKey, "keyType" | "curve">,
  format: "spki" | "pkcs8" | "jwk",
  input: { data?: string; jwk?: object },
): AsymmetricKey {
  let imported: {
    key: {
      type: "public" | "private";
      data: string;
    };
    algorithm: {
      modulusLength?: number;
      publicExponent?: string;
    };
  };
  try {
    imported = webCryptoHost("crypto.importKey", {
      format,
      algorithm: keyAlgorithm(identity),
      ...input,
    }) as typeof imported;
  } catch (error) {
    if (error instanceof WebCryptoFailure) {
      throw format === "jwk"
        ? nodeError(TypeError, "ERR_CRYPTO_INVALID_JWK", "Invalid JWK data")
        : unsupportedKey();
    }
    throw error;
  }
  const key: AsymmetricKey = {
    type: imported.key.type,
    data: fromBase64(imported.key.data),
    keyType: identity.keyType,
  };
  if (identity.curve) {
    key.curve = identity.curve;
  }
  if (identity.keyType === "rsa") {
    key.modulusLength = imported.algorithm.modulusLength;
    const exponent = fromBase64(imported.algorithm.publicExponent!);
    key.publicExponent = exponent.reduce((total, byte) => total * 256n + BigInt(byte), 0n);
  }
  return key;
}

// PEM

interface Pem {
  label: string;
  body: Uint8Array;
}

const pemPattern = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g;

function readPems(text: string): Pem[] {
  return [...text.matchAll(pemPattern)].map((match) => {
    const lines = match[2].split(/\r?\n/);
    if (lines.some((line) => /^Proc-Type:.*ENCRYPTED/.test(line))) {
      throw unavailable("Encrypted PEM");
    }
    const body = lines.filter((line) => !line.includes(":")).join("");
    return {
      label: match[1],
      body: Buffer.from(body, "base64"),
    };
  });
}

function writePem(label: string, data: Uint8Array): string {
  const text = base64(data);
  const lines = text.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

// Conversions between key encodings

function rsaSpki(pkcs1: Uint8Array): Uint8Array {
  return der.sequence(der.sequence(der.oid(oids.rsaEncryption), der.derNull), der.bitString(pkcs1));
}

function rsaPkcs8(pkcs1: Uint8Array): Uint8Array {
  return der.sequence(
    der.unsigned(new Uint8Array([0])),
    der.sequence(der.oid(oids.rsaEncryption), der.derNull),
    der.octetString(pkcs1),
  );
}

function ecPkcs8(sec1: Uint8Array): Uint8Array {
  const parameters = der.children(der.parse(sec1)).find((field) => field.tag === 0xa0);
  if (!parameters) {
    throw unsupportedKey();
  }
  const [curve] = der.children(parameters);
  return der.sequence(
    der.unsigned(new Uint8Array([0])),
    der.sequence(der.oid(oids.ecPublicKey), der.whole(curve)),
    der.octetString(sec1),
  );
}

/** The SubjectPublicKeyInfo of an X.509 certificate. */
function certificateSpki(certificate: Uint8Array): Uint8Array {
  const [tbs] = der.children(der.parse(certificate));
  const fields = der.children(der.expect(tbs, der.tags.sequence));
  // An explicit version comes first as [0].
  const offset = fields[0].tag === 0xa0 ? 1 : 0;
  return der.whole(der.expect(fields[offset + 5], der.tags.sequence));
}

/** The private key inside PKCS #8. */
function pkcs8Inner(pkcs8: Uint8Array): Uint8Array {
  const fields = der.children(der.parse(pkcs8));
  return der.contents(der.expect(fields[2], der.tags.octetString));
}

/** SEC 1 as Node writes it, with the curve parameters. */
function sec1(key: AsymmetricKey): Uint8Array {
  const inner = pkcs8Inner(key.data);
  const fields = der.children(der.parse(inner));
  if (fields.some((field) => field.tag === 0xa0)) {
    return inner;
  }
  const parameters = der.encode(0xa0, der.oid(curveOid(key.curve!)));
  return der.sequence(
    der.whole(fields[0]),
    der.whole(fields[1]),
    parameters,
    ...fields.slice(2).map((field) => der.whole(field)),
  );
}

// Reading key input

type KeyFormat = "pem" | "der" | "jwk";

interface KeyInput {
  key: unknown;
  format?: KeyFormat;
  type?: string;
  encoding?: string;
  // Unencrypted keys ignore a passphrase, as Node does.
  passphrase?: unknown;
}

function keyInput(key: unknown, name: string): KeyInput {
  if (typeof key === "string" || isBinary(key)) {
    return { key };
  }
  if (key !== null && typeof key === "object" && !(key instanceof KeyObject)) {
    return key as KeyInput;
  }
  throw invalidArgType(
    name,
    "of type string or an instance of ArrayBuffer, Buffer, TypedArray, DataView, KeyObject, or CryptoKey",
    key,
  );
}

const jwkPrivateFields = ["d", "p", "q", "dp", "dq", "qi"];

/** The key type and curve of a JWK, and the JWK members Web Crypto imports. */
function jwkIdentity(jwk: Record<string, unknown>): {
  identity: Pick<AsymmetricKey, "keyType" | "curve">;
  jwk: Record<string, unknown>;
} {
  if (jwk === null || typeof jwk !== "object") {
    throw invalidArgType("key.key", "of type object", jwk);
  }
  const { kty, crv } = jwk;
  const members = Object.fromEntries(
    Object.entries(jwk).filter(([name]) => !["alg", "use", "key_ops", "ext"].includes(name)),
  );
  if (kty === "RSA") {
    return { identity: { keyType: "rsa" }, jwk: members };
  }
  if (kty === "EC" && typeof crv === "string" && curveOid(crv)) {
    return { identity: { keyType: "ec", curve: crv }, jwk: members };
  }
  if (kty === "OKP" && (crv === "Ed25519" || crv === "X25519")) {
    return {
      identity: { keyType: crv === "Ed25519" ? "ed25519" : "x25519" },
      jwk: members,
    };
  }
  if (kty === "EC" || kty === "OKP") {
    throw invalidArgValue("key.crv", crv, "must be a supported curve");
  }
  throw nodeError(TypeError, "ERR_CRYPTO_INVALID_JWK", "Invalid JWK data");
}

function readAsymmetric(input: KeyInput, wanted: "public" | "private"): AsymmetricKey {
  const format = input.format ?? "pem";
  if (format === "jwk") {
    const { identity, jwk } = jwkIdentity(input.key as Record<string, unknown>);
    if (wanted === "private" && jwk.d === undefined) {
      throw nodeError(TypeError, "ERR_CRYPTO_INVALID_JWK", "Invalid JWK data");
    }
    const members =
      wanted === "public"
        ? Object.fromEntries(
            Object.entries(jwk).filter(([name]) => !jwkPrivateFields.includes(name)),
          )
        : jwk;
    return importKey(identity, "jwk", { jwk: members });
  }
  if (format === "der") {
    const bytes = toBytes(input.key, "key.key", input.encoding);
    return readDer(bytes, input.type, wanted);
  }
  if (format !== "pem") {
    throw invalidArgValue("options.format", format);
  }
  const text =
    typeof input.key === "string"
      ? input.key
      : Buffer.from(toBytes(input.key, "key.key")).toString("utf8");
  for (const pem of readPems(text)) {
    switch (pem.label) {
      case "PUBLIC KEY":
        if (wanted === "public") {
          return importDer("public", pem.body);
        }
        break;
      case "RSA PUBLIC KEY":
        if (wanted === "public") {
          return importDer("public", rsaSpki(pem.body));
        }
        break;
      case "CERTIFICATE":
        if (wanted === "public") {
          return importDer("public", certificateSpki(pem.body));
        }
        break;
      case "PRIVATE KEY":
        return importDer("private", pem.body);
      case "RSA PRIVATE KEY":
        return importDer("private", rsaPkcs8(pem.body));
      case "EC PRIVATE KEY":
        return importDer("private", ecPkcs8(pem.body));
      case "ENCRYPTED PRIVATE KEY":
        throw unavailable("Encrypted PEM");
    }
  }
  throw unsupportedKey();
}

function readDer(bytes: Uint8Array, type: string | undefined, wanted: "public" | "private") {
  try {
    switch (type) {
      case "spki":
        return importDer("public", bytes);
      case "pkcs1":
        return wanted === "public"
          ? importDer("public", rsaSpki(bytes))
          : importDer("private", rsaPkcs8(bytes));
      case "pkcs8":
        return importDer("private", bytes);
      case "sec1":
        return importDer("private", ecPkcs8(bytes));
    }
  } catch (error) {
    if (error instanceof der.DerError) {
      throw unsupportedKey();
    }
    throw error;
  }
  throw invalidArgValue("options.type", type);
}

// KeyObject

const token = Symbol("KeyObject");

interface Material {
  secret?: Uint8Array;
  asymmetric?: AsymmetricKey;
}

const materials = new WeakMap<KeyObject, Material>();

export class KeyObject {
  readonly #type: KeyType;

  constructor(type: KeyType, handle: unknown) {
    if (handle !== token) {
      throw nodeError(TypeError, "ERR_ILLEGAL_CONSTRUCTOR", "Illegal constructor");
    }
    this.#type = type;
  }

  get type(): KeyType {
    return this.#type;
  }

  static from(_key: unknown): KeyObject {
    throw unavailable("KeyObject.from");
  }

  get asymmetricKeyType(): AsymmetricKeyType | undefined {
    return materials.get(this)?.asymmetric?.keyType;
  }

  get asymmetricKeyDetails(): Record<string, unknown> | undefined {
    const key = materials.get(this)?.asymmetric;
    if (!key) {
      return undefined;
    }
    switch (key.keyType) {
      case "rsa":
        return {
          modulusLength: key.modulusLength,
          publicExponent: key.publicExponent,
        };
      case "ec":
        return { namedCurve: curves[curveOid(key.curve!)].node };
      default:
        return {};
    }
  }

  get symmetricKeySize(): number | undefined {
    return materials.get(this)?.secret?.byteLength;
  }

  equals(otherKeyObject: KeyObject): boolean {
    if (!(otherKeyObject instanceof KeyObject)) {
      throw invalidArgType("otherKeyObject", "an instance of KeyObject", otherKeyObject);
    }
    const left = keyBytes(this);
    const right = keyBytes(otherKeyObject);
    return (
      this.type === otherKeyObject.type &&
      left.byteLength === right.byteLength &&
      left.every((byte, index) => byte === right[index])
    );
  }

  export(options?: Record<string, unknown>): NodeBuffer | string | Record<string, unknown> {
    if (options !== undefined && (options === null || typeof options !== "object")) {
      throw invalidArgType("options", "of type object", options);
    }
    return exportKey(this, options ?? {});
  }

  get [Symbol.toStringTag](): string {
    return "KeyObject";
  }
}

export class SecretKeyObject extends KeyObject {}
export class PublicKeyObject extends KeyObject {}
export class PrivateKeyObject extends KeyObject {}

function keyBytes(key: KeyObject): Uint8Array {
  const material = materials.get(key)!;
  return material.secret ?? material.asymmetric!.data;
}

function secretKeyObject(bytes: Uint8Array): KeyObject {
  const key = new SecretKeyObject("secret", token);
  materials.set(key, { secret: bytes.slice() });
  return key;
}

function asymmetricKeyObject(asymmetric: AsymmetricKey): KeyObject {
  const key =
    asymmetric.type === "public"
      ? new PublicKeyObject("public", token)
      : new PrivateKeyObject("private", token);
  materials.set(key, { asymmetric });
  return key;
}

/** The bytes of a secret key. */
export function secretBytes(key: KeyObject): Uint8Array {
  return materials.get(key)!.secret!;
}

/** The material of an asymmetric key. */
export function asymmetricMaterial(key: KeyObject): AsymmetricKey {
  return materials.get(key)!.asymmetric!;
}

function exportJwk(key: AsymmetricKey): Record<string, unknown> {
  const jwk = webCryptoHost("crypto.exportKey", {
    format: "jwk",
    algorithm: keyAlgorithm(key),
    keyAlgorithm: keyAlgorithm(key),
    key: {
      type: key.type,
      data: base64(key.data),
    },
  }) as Record<string, unknown>;
  const order: Record<AsymmetricKeyType, string[]> = {
    rsa: ["kty", "n", "e", "d", "p", "q", "dp", "dq", "qi"],
    ec: ["kty", "x", "y", "crv", "d"],
    ed25519: ["crv", "d", "x", "kty"],
    x25519: ["crv", "d", "x", "kty"],
  };
  const fields = order[key.keyType].filter((name) => jwk[name] !== undefined);
  if (key.keyType === "ec") {
    jwk.crv = key.curve;
  }
  return Object.fromEntries(fields.map((name) => [name, jwk[name]]));
}

function exportKey(
  key: KeyObject,
  options: Record<string, unknown>,
): NodeBuffer | string | Record<string, unknown> {
  const material = materials.get(key)!;
  const { format, type } = options;
  if (material.secret) {
    if (format === "jwk") {
      return {
        kty: "oct",
        k: Buffer.from(material.secret).toString("base64url"),
      };
    }
    if (format !== undefined && format !== "buffer") {
      throw invalidArgValue("options.format", format, "must be one of: undefined, 'buffer', 'jwk'");
    }
    return Buffer.from(material.secret);
  }
  const asymmetric = material.asymmetric!;
  if (format === "jwk") {
    return exportJwk(asymmetric);
  }
  if (format !== "pem" && format !== "der") {
    throw invalidArgValue("options.format", format);
  }
  if (options.cipher !== undefined) {
    throw unavailable("Encrypting exported private keys");
  }
  const incompatible = (encoding: string, kind: string) =>
    nodeError(
      Error,
      "ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS",
      `The selected key encoding ${encoding} can only be used for ${kind} keys.`,
    );
  let data: Uint8Array;
  let label: string;
  if (asymmetric.type === "public") {
    if (type === "spki") {
      data = asymmetric.data;
      label = "PUBLIC KEY";
    } else if (type === "pkcs1") {
      if (asymmetric.keyType !== "rsa") {
        throw incompatible("pkcs1", "RSA");
      }
      data = der.readBitString(der.children(der.parse(asymmetric.data))[1]);
      label = "RSA PUBLIC KEY";
    } else {
      throw invalidArgValue("options.type", type);
    }
  } else if (type === "pkcs8") {
    data = asymmetric.data;
    label = "PRIVATE KEY";
  } else if (type === "pkcs1") {
    if (asymmetric.keyType !== "rsa") {
      throw incompatible("pkcs1", "RSA");
    }
    data = pkcs8Inner(asymmetric.data);
    label = "RSA PRIVATE KEY";
  } else if (type === "sec1") {
    if (asymmetric.keyType !== "ec") {
      throw incompatible("sec1", "EC");
    }
    data = sec1(asymmetric);
    label = "EC PRIVATE KEY";
  } else {
    throw invalidArgValue("options.type", type);
  }
  return format === "pem" ? writePem(label, data) : Buffer.from(data);
}

// Creating keys

export function createSecretKey(key: unknown, encoding?: string): KeyObject {
  if (typeof key !== "string" && !isBinary(key)) {
    throw invalidArgType(
      "key",
      "of type string or an instance of ArrayBuffer, Buffer, TypedArray, or DataView",
      key,
    );
  }
  return secretKeyObject(toBytes(key, "key", encoding));
}

/** The public key of a private key. */
function publicOf(key: AsymmetricKey): AsymmetricKey {
  const jwk = exportJwk(key);
  const members = Object.fromEntries(
    Object.entries(jwk).filter(([name]) => !jwkPrivateFields.includes(name)),
  );
  return importKey(key, "jwk", { jwk: members });
}

export function createPublicKey(key: unknown): KeyObject {
  if (key instanceof KeyObject) {
    if (key.type !== "private") {
      throw nodeError(
        TypeError,
        "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE",
        `Invalid key object type ${key.type}, expected private.`,
      );
    }
    return asymmetricKeyObject(publicOf(asymmetricMaterial(key)));
  }
  const input = keyInput(key, "key");
  if (input.key instanceof KeyObject) {
    return createPublicKey(input.key);
  }
  const material = readAsymmetric(input, "public");
  return asymmetricKeyObject(material.type === "private" ? publicOf(material) : material);
}

export function createPrivateKey(key: unknown): KeyObject {
  const input = keyInput(key, "key");
  const material = readAsymmetric(input, "private");
  if (material.type !== "private") {
    throw unsupportedKey();
  }
  return asymmetricKeyObject(material);
}

/**
 * A key argument of sign, verify and the RSA and Diffie-Hellman functions:
 * a KeyObject, key input as createPrivateKey or createPublicKey takes it,
 * or an object holding either with options for the operation.
 */
export function prepareAsymmetricKey(
  key: unknown,
  wanted: "public" | "private",
): { key: AsymmetricKey; options: Record<string, unknown> } {
  if (key instanceof KeyObject) {
    if (key.type === "secret") {
      throw nodeError(
        TypeError,
        "ERR_CRYPTO_INVALID_KEY_OBJECT_TYPE",
        `Invalid key object type secret, expected ${wanted}.`,
      );
    }
    const material = asymmetricMaterial(key);
    return {
      key: wanted === "public" && material.type === "private" ? publicOf(material) : material,
      options: {},
    };
  }
  const input = keyInput(key, "key");
  const options = input as unknown as Record<string, unknown>;
  if (input.key instanceof KeyObject) {
    return {
      key: prepareAsymmetricKey(input.key, wanted).key,
      options,
    };
  }
  const material = readAsymmetric(input, wanted);
  return {
    key: wanted === "public" && material.type === "private" ? publicOf(material) : material,
    options,
  };
}

// Generating keys

interface KeyEncoding {
  format?: string;
  type?: string;
  cipher?: string;
  passphrase?: unknown;
}

interface KeyPairOptions {
  modulusLength?: number;
  publicExponent?: number;
  namedCurve?: string;
  publicKeyEncoding?: KeyEncoding;
  privateKeyEncoding?: KeyEncoding;
}

function generateMaterial(type: string, options: KeyPairOptions) {
  let identity: Pick<AsymmetricKey, "keyType" | "curve">;
  const algorithm: Record<string, unknown> = {};
  switch (type) {
    case "rsa": {
      validateInteger(options.modulusLength, "options.modulusLength", 0);
      const exponent = options.publicExponent ?? 0x10001;
      validateInteger(exponent, "options.publicExponent", 0);
      const bytes: number[] = [];
      for (let rest = exponent; rest > 0; rest = Math.floor(rest / 256)) {
        bytes.unshift(rest % 256);
      }
      identity = { keyType: "rsa" };
      algorithm.modulusLength = options.modulusLength;
      algorithm.publicExponent = base64(new Uint8Array(bytes));
      break;
    }
    case "ec": {
      if (typeof options.namedCurve !== "string") {
        throw invalidArgType("options.namedCurve", "of type string", options.namedCurve);
      }
      const curve = curveNames[options.namedCurve.toLowerCase()];
      if (!curve) {
        throw nodeError(TypeError, "ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name");
      }
      identity = { keyType: "ec", curve };
      break;
    }
    case "ed25519":
    case "x25519":
      identity = { keyType: type };
      break;
    default:
      throw invalidArgValue("type", type, "must be a supported key type");
  }
  let pair: {
    publicKey: { data: string };
    privateKey: { data: string };
    algorithm: { modulusLength?: number; publicExponent?: string };
  };
  try {
    pair = webCryptoHost("crypto.generateKey", {
      algorithm: { ...keyAlgorithm(identity), ...algorithm },
    }) as typeof pair;
  } catch (error) {
    if (error instanceof WebCryptoFailure) {
      throw nodeError(Error, "ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED", error.message);
    }
    throw error;
  }
  const details: Partial<AsymmetricKey> = {};
  if (identity.keyType === "rsa") {
    details.modulusLength = pair.algorithm.modulusLength;
    details.publicExponent = BigInt(options.publicExponent ?? 0x10001);
  }
  const make = (kind: "public" | "private", data: string) =>
    asymmetricKeyObject({
      type: kind,
      data: fromBase64(data),
      ...identity,
      ...details,
    });
  return {
    publicKey: make("public", pair.publicKey.data),
    privateKey: make("private", pair.privateKey.data),
  };
}

function encodeGenerated(key: KeyObject, encoding: KeyEncoding | undefined, name: string) {
  if (encoding === undefined) {
    return key;
  }
  if (encoding === null || typeof encoding !== "object") {
    throw invalidArgType(name, "of type object", encoding);
  }
  return key.export(encoding as Record<string, unknown>);
}

export function generateKeyPairSync(
  type: string,
  options?: Omit<KeyPairOptions, "publicKeyEncoding" | "privateKeyEncoding">,
): { publicKey: PublicKeyObject; privateKey: PrivateKeyObject };
export function generateKeyPairSync(
  type: string,
  options?: KeyPairOptions,
): {
  publicKey: ReturnType<typeof encodeGenerated>;
  privateKey: ReturnType<typeof encodeGenerated>;
};
export function generateKeyPairSync(type: string, options: KeyPairOptions = {}) {
  if (typeof type !== "string") {
    throw invalidArgType("type", "of type string", type);
  }
  const { publicKey, privateKey } = generateMaterial(type, options);
  return {
    publicKey: encodeGenerated(publicKey, options.publicKeyEncoding, "options.publicKeyEncoding"),
    privateKey: encodeGenerated(
      privateKey,
      options.privateKeyEncoding,
      "options.privateKeyEncoding",
    ),
  };
}

export function generateKeyPair(
  type: string,
  options: KeyPairOptions,
  callback: (error: Error | null, publicKey?: unknown, privateKey?: unknown) => void,
) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  validateFunction(callback, "callback");
  callLater(callback, () => {
    const pair = generateKeyPairSync(type, options);
    return [pair.publicKey, pair.privateKey] as [unknown, unknown];
  });
}

export function generateKeySync(type: string, options: { length: number }): KeyObject {
  if (options === null || typeof options !== "object") {
    throw invalidArgType("options", "of type object", options);
  }
  const { length } = options;
  if (type === "hmac") {
    validateInteger(length, "options.length", 8, 2 ** 31 - 1);
  } else if (type === "aes") {
    if (length !== 128 && length !== 192 && length !== 256) {
      throw invalidArgValue("options.length", length, "must be one of: 128, 192, 256");
    }
  } else {
    throw invalidArgValue("type", type, "must be a supported key type");
  }
  const bytes = new Uint8Array(Math.floor(length / 8));
  globalThis.crypto.getRandomValues(bytes);
  return secretKeyObject(bytes);
}

export function generateKey(
  type: string,
  options: { length: number },
  callback: (error: Error | null, key?: KeyObject) => void,
) {
  validateFunction(callback, "callback");
  callLater(callback, () => [generateKeySync(type, options)] as [KeyObject]);
}
