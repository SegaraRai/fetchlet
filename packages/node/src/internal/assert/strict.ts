// node:assert/strict: node:assert with the strict comparisons under the
// loose names.

import { strict } from "./assert.ts";

export const {
  ok,
  fail,
  equal,
  notEqual,
  strictEqual,
  notStrictEqual,
  deepEqual,
  notDeepEqual,
  deepStrictEqual,
  notDeepStrictEqual,
  throws,
  doesNotThrow,
  rejects,
  doesNotReject,
  ifError,
  match,
  doesNotMatch,
  AssertionError,
} = strict;

export { strict };
