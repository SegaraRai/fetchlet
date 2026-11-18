// node:async_hooks for engines that propagate async context (V8 and Boa):
// AsyncLocalStorage and AsyncResource over @fetchlet/web's AsyncContext
// Variable and Snapshot, as Node implements them over AsyncContextFrame.

import {
  AsyncLocalStorage,
  AsyncResource,
  asyncWrapProviders,
  createHook,
  executionAsyncId,
  executionAsyncResource,
  triggerAsyncId,
} from "./internal/async-hooks/async-context.ts";

export {
  AsyncLocalStorage,
  AsyncResource,
  asyncWrapProviders,
  createHook,
  executionAsyncId,
  executionAsyncResource,
  triggerAsyncId,
};

export default {
  AsyncLocalStorage,
  AsyncResource,
  executionAsyncId,
  triggerAsyncId,
  executionAsyncResource,
  createHook,
  asyncWrapProviders,
};
