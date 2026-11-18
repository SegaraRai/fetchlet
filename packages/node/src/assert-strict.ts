// node:assert/strict: node:assert with the strict comparisons under the loose
// names.

export {
  AssertionError,
  deepEqual,
  deepStrictEqual,
  strict as default,
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
} from "./internal/assert/strict.ts";
