// CryptoKey (https://w3c.github.io/webcrypto/#cryptokey-interface). The key
// material stays in a module-private slot: raw bytes for secret keys,
// SubjectPublicKeyInfo for public keys and PKCS #8 for private keys.

import { exposeAttributes } from "../webidl/idl";
import { recognizeKeys } from "./algorithms";

export type KeyType = "secret" | "public" | "private";

export interface KeySlots {
  type: KeyType;
  extractable: boolean;
  /** The key algorithm, which the host and the operations read. */
  algorithm: any;
  usages: string[];
  /** Base64 key material. */
  data: string;
  /** The objects the algorithm and usages attributes return. */
  algorithmView: any;
  usagesView: string[];
}

const slots = new WeakMap<object, KeySlots>();
const construct = Symbol("CryptoKey");

/** A JavaScript copy of a key algorithm, with its own Uint8Array and hash objects. */
function view(algorithm: any): any {
  const copy = { ...algorithm };
  if (algorithm.hash) {
    copy.hash = { name: algorithm.hash.name };
  }
  if (algorithm.publicExponent) {
    copy.publicExponent = new Uint8Array(algorithm.publicExponent);
  }
  return copy;
}

export class CryptoKey {
  constructor(token?: unknown) {
    if (token !== construct) {
      throw new TypeError("Illegal constructor");
    }
  }

  get type(): KeyType {
    return keySlots(this).type;
  }

  get extractable(): boolean {
    return keySlots(this).extractable;
  }

  get algorithm(): any {
    return keySlots(this).algorithmView;
  }

  get usages(): string[] {
    return keySlots(this).usagesView;
  }
}

exposeAttributes(CryptoKey.prototype, ["type", "extractable", "algorithm", "usages"]);
Object.defineProperty(CryptoKey.prototype, Symbol.toStringTag, {
  value: "CryptoKey",
  configurable: true,
});

export function isCryptoKey(value: unknown): value is CryptoKey {
  return typeof value === "object" && value !== null && slots.has(value);
}

recognizeKeys(isCryptoKey);

export function keySlots(key: unknown): KeySlots {
  const found = typeof key === "object" && key !== null ? slots.get(key) : undefined;
  if (!found) {
    throw new TypeError("Expected a CryptoKey");
  }
  return found;
}

export function createKey(
  type: KeyType,
  extractable: boolean,
  algorithm: any,
  usages: string[],
  data: string,
): CryptoKey {
  const key = new CryptoKey(construct);
  slots.set(key, {
    type,
    extractable,
    algorithm,
    usages,
    data,
    algorithmView: view(algorithm),
    usagesView: [...usages],
  });
  return key;
}

/** The key as the host's messages carry it. */
export function hostKey(key: KeySlots) {
  return { type: key.type, data: key.data };
}
