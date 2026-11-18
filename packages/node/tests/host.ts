// A stand-in for the fetchlet host's nodeCrypto operations, computed with
// Node's own crypto, so node:crypto can be compared with Node in Vitest. The
// host crate checks its operations against published vectors itself.

import * as crypto from "node:crypto";

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

/** Installs the stand-in as globalThis.__fetchletHost and returns its operation log. */
export function installHost(): string[] {
  const calls: string[] = [];
  (globalThis as { __fetchletHost?: unknown }).__fetchletHost = (
    operation: string,
    input: string,
  ) => {
    calls.push(operation);
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
