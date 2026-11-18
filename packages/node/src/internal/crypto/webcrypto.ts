// The profile's Web Crypto, as node:crypto exposes it.

export const webCrypto = (globalThis as unknown as { crypto: Crypto }).crypto;

export function getRandomValues<T extends ArrayBufferView | null>(array: T): T {
  return webCrypto.getRandomValues(array as unknown as Uint8Array<ArrayBuffer>) as unknown as T;
}

export const webcrypto = webCrypto;
export const subtle = webCrypto.subtle;
