// node:async_hooks for engines without async context propagation.

import {
  AsyncLocalStorage,
  AsyncResource,
  asyncWrapProviders,
  createHook,
  executionAsyncId,
  executionAsyncResource,
  triggerAsyncId,
} from "./internal/async-hooks/serialized.ts";

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
