// node:buffer: Buffer from the `buffer` package, which implements Node's
// Buffer on Uint8Array, with the module's other exports over Web APIs.

import {
  atob,
  Blob,
  btoa,
  Buffer,
  constants,
  File,
  INSPECT_MAX_BYTES,
  isAscii,
  isUtf8,
  kMaxLength,
  kStringMaxLength,
  SlowBuffer,
} from "./internal/buffer/buffer.ts";

export {
  atob,
  Blob,
  btoa,
  Buffer,
  constants,
  File,
  INSPECT_MAX_BYTES,
  isAscii,
  isUtf8,
  kMaxLength,
  kStringMaxLength,
  SlowBuffer,
};

export default {
  Buffer,
  SlowBuffer,
  INSPECT_MAX_BYTES,
  kMaxLength,
  kStringMaxLength,
  constants,
  atob,
  btoa,
  Blob,
  File,
  isUtf8,
  isAscii,
};
