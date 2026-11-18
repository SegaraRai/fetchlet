// node:assert and node:assert/strict.

import {
  AssertionError,
  deepEqual,
  deepStrictEqual,
  doesNotMatch,
  doesNotReject,
  doesNotThrow,
  equal,
  ifError,
  legacy,
  match,
  notDeepEqual,
  notDeepStrictEqual,
  notEqual,
  notStrictEqual,
  ok,
  rejects,
  strict,
  strictEqual,
  throws,
  fail,
} from "./internal/assert/assert.ts";

export {
  fail,
  AssertionError,
  deepEqual,
  deepStrictEqual,
  doesNotMatch,
  doesNotReject,
  doesNotThrow,
  equal,
  ifError,
  match,
  notDeepEqual,
  notDeepStrictEqual,
  notEqual,
  notStrictEqual,
  ok,
  rejects,
  strict,
  strictEqual,
  throws,
};

export default legacy;
