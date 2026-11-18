// node:buffer: Buffer from the `buffer` package, which implements Node's
// Buffer on Uint8Array, with the module's other exports over Web APIs. The
// package is imported by file, so a bundler and Node both load it rather
// than Node's own module of the same name.

import * as bufferModule from "buffer/index.js";

// The package's typings declare Buffer only.
const bufferPackage = bufferModule as typeof bufferModule & {
  INSPECT_MAX_BYTES: number;
  kMaxLength: number;
};

export const Buffer = bufferPackage.Buffer;

// The package predates Node's "base64url" encoding. Its base64 decoder
// already accepts the URL-safe alphabet, so decoding maps the name to
// "base64", and encoding converts base64 output.
const isBase64url = (value: unknown) =>
  typeof value === "string" && value.toLowerCase() === "base64url";
const decodingArguments = (args: unknown[]) =>
  args.map((value) => (isBase64url(value) ? "base64" : value));

type Method = (this: unknown, ...args: unknown[]) => unknown;
const bufferStatics = Buffer as unknown as Record<string, Method>;
const bufferMethods = Buffer.prototype as unknown as Record<string, Method>;

for (const name of ["from", "byteLength", "alloc"]) {
  const original = bufferStatics[name];
  bufferStatics[name] = function (this: unknown, ...args: unknown[]) {
    return original.apply(this, decodingArguments(args));
  };
}
for (const name of ["write", "fill", "indexOf", "lastIndexOf", "includes"]) {
  const original = bufferMethods[name];
  bufferMethods[name] = function (this: unknown, ...args: unknown[]) {
    return original.apply(this, decodingArguments(args));
  };
}
const isEncoding = bufferStatics.isEncoding;
bufferStatics.isEncoding = function (this: unknown, encoding: unknown) {
  return isBase64url(encoding) || (isEncoding.call(this, encoding) as boolean);
};
const toString = bufferMethods.toString as unknown as Method;
bufferMethods["toString"] = function (this: unknown, encoding?: unknown, ...rest: unknown[]) {
  if (!isBase64url(encoding)) {
    return toString.apply(this, [encoding, ...rest]);
  }
  return (toString.apply(this, ["base64", ...rest]) as string)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+/, "");
};

export const INSPECT_MAX_BYTES = bufferPackage.INSPECT_MAX_BYTES;
export const kMaxLength = bufferPackage.kMaxLength;
export const kStringMaxLength = 2 ** 29 - 24;
export const constants = {
  MAX_LENGTH: kMaxLength,
  MAX_STRING_LENGTH: kStringMaxLength,
};

const runtime = globalThis as unknown as {
  atob(data: string): string;
  btoa(data: string): string;
  Blob: typeof globalThis.Blob;
  File: typeof globalThis.File;
};

export const atob = (data: string): string => runtime.atob(data);
export const btoa = (data: string): string => runtime.btoa(data);
export const Blob = runtime.Blob;
export const File = runtime.File;

function view(input: ArrayBufferView | ArrayBuffer): Uint8Array {
  return ArrayBuffer.isView(input)
    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    : new Uint8Array(input);
}

export function isUtf8(input: ArrayBufferView | ArrayBuffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(view(input));
    return true;
  } catch {
    return false;
  }
}

export function isAscii(input: ArrayBufferView | ArrayBuffer): boolean {
  return view(input).every((byte) => byte < 0x80);
}
