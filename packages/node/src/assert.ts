// node:assert and node:assert/strict.

export {
  AssertionError,
  deepEqual,
  deepStrictEqual,
  legacy as default,
  doesNotMatch,
  doesNotReject,
  doesNotThrow,
  equal,
  fail,
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
} from "./internal/assert/assert.ts";
