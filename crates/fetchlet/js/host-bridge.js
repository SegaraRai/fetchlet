// Rust installs the host bindings before evaluating this script. The bridge
// takes them off the global object: the bundle claims them once, with
// __fetchletClaimHost, while it is evaluated, and Rust deletes that function
// after the bundle (SEAL_HOST in execution/script.rs). Application code then
// reaches the host only through fetch, fetchlet.env and the APIs the bundle
// built on the claimed functions.

(() => {
  const nativeDispatch = globalThis.__fetchletHost;
  // Body bytes cross the bridge as typed arrays in the invocation's byte store;
  // JSON messages carry their handles.
  const takeBytes = globalThis.__fetchletTakeBytes;
  const putBytes = globalThis.__fetchletPutBytes;
  delete globalThis.__fetchletHost;
  delete globalThis.__fetchletTakeBytes;
  delete globalThis.__fetchletPutBytes;

  Object.defineProperty(globalThis, "__fetchletClaimHost", {
    value() {
      delete globalThis.__fetchletClaimHost;
      return Object.freeze({
        call: (operation, input) => nativeDispatch(operation, input),
        putBytes: (bytes) => putBytes(bytes),
        takeBytes: (handle) => takeBytes(handle),
      });
    },
    writable: false,
    enumerable: false,
    configurable: true,
  });

  // Aborts the request signal of the Fetch invocation in progress when its
  // client goes away: Rust cancels the response body, or reports through
  // invocation.disconnected that the caller left while a call runs on.
  let requestAbort = null;

  function abortRequest() {
    const controller = requestAbort;
    requestAbort = null;
    controller?.abort();
  }

  const pendingFetches = new Map();
  // Outstanding reads of Rust bodies: ticket -> { id, resolve, reject }.
  const pendingReads = new Map();

  function hostError(description) {
    const error = new Error(description.message);
    error.name = "FetchletHostError";
    error.code = description.code;
    return error;
  }

  function dispatch(operation, input) {
    const reply = JSON.parse(nativeDispatch(operation, JSON.stringify(input)));
    if (!reply.ok) {
      throw hostError(reply.error);
    }
    return reply.value;
  }

  const bindings = dispatch("bindings", null);

  function formatConsoleValue(value) {
    if (typeof value === "string") {
      return value;
    }
    if (value instanceof Error) {
      const stack = typeof value.stack === "string" ? value.stack : "";
      const head = value.name + ": " + value.message;
      return stack.includes(value.message) ? stack : head + (stack ? "\n" + stack : "");
    }
    if (typeof value === "object" && value !== null) {
      try {
        return JSON.stringify(value);
      } catch {
        return Object.prototype.toString.call(value);
      }
    }
    return String(value);
  }

  // The host's console sink receives one formatted message per call. Logging
  // never throws into the application: a message the bridge refuses, such as
  // one over the message budget, is replaced by a notice.
  function installConsole() {
    const write =
      (level) =>
      (...values) => {
        try {
          dispatch("console.write", {
            level,
            message: values.map(formatConsoleValue).join(" "),
          });
        } catch {
          try {
            dispatch("console.write", {
              level,
              message: "[fetchlet: console message dropped]",
            });
          } catch {
            // The sink is unavailable; output is discarded as without a sink.
          }
        }
      };
    globalThis.console = Object.assign(globalThis.console ?? {}, {
      debug: write("debug"),
      log: write("log"),
      info: write("info"),
      warn: write("warn"),
      error: write("error"),
    });
  }

  function exceedsBudget(observed, budget) {
    return budget !== null && BigInt(observed) > BigInt(budget);
  }

  async function readRequestBody(request, limits) {
    if (request.body === null) {
      return null;
    }

    const reader = request.body.getReader();
    const chunks = [];
    let byteLength = 0;
    let chunkCount = 0;

    function abortBodyRead() {
      void reader.cancel(request.signal.reason).catch(() => {});
    }

    request.signal.addEventListener("abort", abortBodyRead, { once: true });

    try {
      while (true) {
        request.signal.throwIfAborted();
        const { value, done } = await reader.read();
        request.signal.throwIfAborted();

        if (done) {
          break;
        }

        chunkCount += 1;
        if (exceedsBudget(chunkCount, limits.requestBodyChunks)) {
          await reader.cancel();
          throw hostError({
            code: "LIMIT_EXCEEDED",
            message: "Request body has too many chunks",
          });
        }

        if (!(value instanceof Uint8Array)) {
          throw new TypeError("Request body must contain byte chunks");
        }

        byteLength += value.byteLength;
        if (exceedsBudget(byteLength, limits.requestBodyBytes)) {
          await reader.cancel();
          throw hostError({
            code: "LIMIT_EXCEEDED",
            message: "Request body exceeds the bridge limit",
          });
        }

        if (value.byteLength > 0) {
          chunks.push(value);
        }
      }
    } finally {
      request.signal.removeEventListener("abort", abortBodyRead);
      reader.releaseLock();
    }

    const bytes = new Uint8Array(byteLength);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return bytes;
  }

  function responseFromWire(response, signal) {
    const hasNoBody = [204, 205, 304].includes(response.status);
    let body = null;
    if (typeof response.stream === "number") {
      // The upstream body is still arriving; read it on demand.
      body = hostBodyStream(response.stream, signal);
    } else if (!hasNoBody) {
      body = takeBytes(response.body);
    }

    return new Response(body, {
      status: response.status,
      headers: response.headers,
    });
  }

  function pumpHostOperations() {
    let progress = 0;
    if (requestAbort !== null && dispatch("invocation.disconnected", null)) {
      abortRequest();
      progress = 1;
    }
    if (pendingFetches.size === 0 && pendingReads.size === 0) {
      return progress;
    }

    const completions = dispatch("fetch.poll", null);
    for (const completion of completions) {
      const read = pendingReads.get(completion.id);
      if (read) {
        pendingReads.delete(completion.id);
        if (completion.result.ok) {
          read.resolve(completion.result.value);
        } else {
          read.reject(hostError(completion.result.error));
        }
        continue;
      }

      const pending = pendingFetches.get(completion.id);
      if (!pending) {
        continue;
      }

      pendingFetches.delete(completion.id);
      pending.cleanup();

      if (completion.result.ok) {
        pending.resolve(responseFromWire(completion.result.value, pending.signal));
      } else {
        pending.reject(hostError(completion.result.error));
      }
    }

    return completions.length + progress;
  }

  function waitForResponse(ticket, signal) {
    return new Promise((resolve, reject) => {
      function abort() {
        if (!pendingFetches.delete(ticket)) {
          return;
        }

        try {
          dispatch("fetch.cancel", ticket);
        } catch {
          // The invocation may have closed before this abort notification.
        }

        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      }

      pendingFetches.set(ticket, {
        resolve,
        reject,
        signal,
        cleanup: () => signal.removeEventListener("abort", abort),
      });

      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
      }
    });
  }

  async function hostFetch(input, init, service) {
    const request = new Request(input, init);
    request.signal.throwIfAborted();

    const limits = dispatch("invocation.limits", null);
    const body = await readRequestBody(request, limits);
    request.signal.throwIfAborted();

    // Store the bytes right before the message that takes them.
    const ticket = dispatch("fetch.start", {
      service: service ?? null,
      redirect: request.redirect,
      request: {
        url: request.url,
        method: request.method,
        headers: Array.from(request.headers),
        body: body === null ? null : putBytes(body),
      },
    });

    return waitForResponse(ticket, request.signal);
  }

  let byteStreams;

  function supportsByteStreams() {
    if (byteStreams === undefined) {
      try {
        new ReadableStream({ type: "bytes" });
        byteStreams = true;
      } catch {
        byteStreams = false;
      }
    }
    return byteStreams;
  }

  function readHostBody(id) {
    const ticket = dispatch("body.read", id);
    return new Promise((resolve, reject) => {
      pendingReads.set(ticket, {
        id,
        resolve,
        reject,
      });
    });
  }

  function cancelHostBody(id) {
    for (const [ticket, pending] of pendingReads) {
      if (pending.id === id) {
        pendingReads.delete(ticket);
      }
    }
    try {
      dispatch("body.cancel", id);
    } catch {
      // The invocation may have ended, which released the body already.
    }
  }

  // A ReadableStream over a Rust body in the current invocation. Chunks are
  // read only when the stream pulls, so Rust applies backpressure to the
  // producer; cancelling the stream drops the Rust body. An abort of the
  // fetch's signal errors the stream and drops the body as well.
  function hostBodyStream(id, signal) {
    let controller;
    let open = true;

    function finish() {
      open = false;
      signal?.removeEventListener("abort", abort);
    }

    function abort() {
      if (!open) {
        return;
      }
      finish();
      cancelHostBody(id);
      controller.error(signal.reason);
    }

    const source = {
      start(streamController) {
        controller = streamController;
        signal?.addEventListener("abort", abort, { once: true });
      },
      pull(streamController) {
        return readHostBody(id).then(
          ({ chunk, done }) => {
            if (!open) {
              return;
            }
            if (done) {
              finish();
              streamController.close();
            } else {
              streamController.enqueue(takeBytes(chunk));
            }
          },
          (error) => {
            finish();
            throw error;
          },
        );
      },
      cancel() {
        if (open) {
          finish();
          cancelHostBody(id);
        }
      },
    };
    return supportsByteStreams()
      ? new ReadableStream({ ...source, type: "bytes" })
      : new ReadableStream(source, { highWaterMark: 0 });
  }

  Object.defineProperty(globalThis, "__fetchletHostBodies", {
    value: Object.freeze({
      stream: hostBodyStream,
    }),
    writable: false,
    configurable: false,
  });

  // Fetch response bodies that stay open after the handler returns. Rust pulls
  // them on demand. Every entry belongs to the current invocation: ids are only
  // meaningful within it, and the registry is emptied when it begins and ends.
  const responseBodies = new Map();
  let nextResponseBody = 1;
  let streamingCall = false;
  const nextTurn = Symbol("nextTurn");
  // Coalescing granularity, not a budget: stop merging available chunks into
  // one bridge message at this size, so a fast producer still meets the Rust
  // queue's backpressure. Limits.response_body_bytes bounds the whole body.
  const coalesceBytes = 64 * 1024;

  function responseChunk(value) {
    if (!(value instanceof Uint8Array)) {
      throw new TypeError("Response body must contain byte chunks");
    }
    return value;
  }

  // Resolve after queued promise jobs, so that reads already satisfiable
  // without a timer or host event are drained into one message.
  function afterQueuedJobs(timers) {
    return new Promise((resolve) => {
      if (typeof globalThis.setTimeout === "function") {
        timers.push(globalThis.setTimeout(() => resolve(nextTurn), 0));
      } else {
        resolve(nextTurn);
      }
    });
  }

  async function drain(entry, waitForData) {
    const chunks = [];
    let byteLength = 0;
    let done = false;
    const timers = [];

    try {
      while (byteLength < coalesceBytes) {
        entry.pending ??= entry.reader.read();
        const mustWait = waitForData && byteLength === 0;
        const result = mustWait
          ? await entry.pending
          : await Promise.race([entry.pending, afterQueuedJobs(timers)]);
        if (result === nextTurn) {
          break;
        }
        entry.pending = null;
        if (result.done) {
          done = true;
          break;
        }
        const chunk = responseChunk(result.value);
        if (chunk.byteLength > 0) {
          chunks.push(chunk);
          byteLength += chunk.byteLength;
        }
      }
    } finally {
      for (const timer of timers) {
        globalThis.clearTimeout?.(timer);
      }
    }

    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      chunk: bytes,
      done,
    };
  }

  const responseBodyRegistry = Object.freeze({
    beginCall(streaming) {
      // Nothing from an earlier invocation is reachable from this one.
      responseBodyRegistry.closeAll();
      pendingReads.clear();
      backgroundTasks.clear();
      streamingCall = streaming;
    },
    endCall() {
      streamingCall = false;
    },
    // True while a Fetch handler called by a streaming-capable host runs.
    streaming() {
      return streamingCall;
    },
    openCount() {
      return responseBodies.size;
    },
    register(stream) {
      const id = nextResponseBody++;
      responseBodies.set(id, { reader: stream.getReader(), pending: null });
      return id;
    },
    async pull(id, waitForData) {
      const entry = responseBodies.get(id);
      if (!entry) {
        throw new TypeError("Unknown response body");
      }
      try {
        const result = await drain(entry, waitForData);
        if (result.done) {
          responseBodies.delete(id);
        }
        return result;
      } catch (error) {
        responseBodies.delete(id);
        throw error;
      }
    },
    async cancel(id) {
      const entry = responseBodies.get(id);
      responseBodies.delete(id);
      await entry?.reader.cancel().catch(() => {});
    },
    // Keep only the body handed to the host in the Fetch result; cancel the
    // rest. Returns whether that body is still open.
    retain(id) {
      for (const [key, entry] of responseBodies) {
        if (key !== id) {
          responseBodies.delete(key);
          void entry.reader.cancel().catch(() => {});
        }
      }
      return responseBodies.has(id);
    },
    closeAll() {
      for (const entry of responseBodies.values()) {
        void entry.reader.cancel().catch(() => {});
      }
      responseBodies.clear();
    },
  });

  Object.defineProperty(globalThis, "__fetchletResponseBodies", {
    value: responseBodyRegistry,
    writable: false,
    configurable: false,
  });

  // Background work registered with fetchlet.waitUntil. The invocation stays
  // open, with its timers and host scope, until every task settles; Rust
  // bounds that with Limits::background_timeout. Rejections are absorbed: a
  // task's outcome does not change the response.
  const backgroundTasks = new Set();

  function waitUntil(promise) {
    // Throws outside an invocation or over Limits::background_tasks.
    dispatch("background.register", null);
    const task = Promise.resolve(promise)
      .then(
        () => {},
        () => {},
      )
      .then(() => {
        backgroundTasks.delete(task);
        try {
          dispatch("background.settle", null);
        } catch {
          // The invocation ended; nothing waits for this task any more.
        }
      });
    backgroundTasks.add(task);
  }

  const backgroundRegistry = Object.freeze({
    pending() {
      return backgroundTasks.size;
    },
    // Resolve once every task, including ones registered meanwhile, settled.
    async settle() {
      while (backgroundTasks.size > 0) {
        await Promise.all(Array.from(backgroundTasks));
      }
    },
    // Forget tasks of an invocation that ended without settling them.
    clear() {
      backgroundTasks.clear();
    },
  });

  Object.defineProperty(globalThis, "__fetchletBackground", {
    value: backgroundRegistry,
    writable: false,
    configurable: false,
  });

  function clearInvocation() {
    requestAbort = null;
    responseBodyRegistry.closeAll();
    // Background work keeps its timers until Rust settles it.
    if (backgroundTasks.size === 0) {
      globalThis.__fetchletClearTimers?.();
      globalThis.__fetchletClearPerformanceEntries?.();
    }
  }

  // Call an exported function. With streamResponseBody, it is a Fetch
  // handler: its request body arrives through the byte store or as a Rust
  // body source, and a response body it leaves open keeps the invocation,
  // with its timers, open until Rust finishes or cancels that body.
  async function invokeExport(exportName, argumentsList, streamResponseBody) {
    // Each invocation starts in the empty async context, whatever the
    // previous one left current.
    globalThis.__fetchletAsyncContext?.set(undefined);
    const exports = globalThis.fetchletExports;
    let invocationRemainsOpen = false;
    responseBodyRegistry.beginCall(streamResponseBody === true);

    try {
      if (!Object.hasOwn(exports, exportName)) {
        throw new TypeError("Unknown function");
      }

      const exportedFunction = exports[exportName];
      if (typeof exportedFunction !== "function") {
        throw new TypeError("Unknown function");
      }

      if (streamResponseBody === true) {
        const request = argumentsList[0];
        if (typeof globalThis.AbortController === "function" && request !== null) {
          requestAbort = new globalThis.AbortController();
          // Not JSON: wireRequest passes it to the Request it builds.
          request.signal = requestAbort.signal;
        }
        if (typeof request?.body === "number") {
          request.body = takeBytes(request.body);
        } else if (typeof request?.stream === "number") {
          request.body = hostBodyStream(request.stream);
          delete request.stream;
        }
      }

      let result = await exportedFunction(...argumentsList);
      if (streamResponseBody === true) {
        // Hand a typed-array response body to Rust through the byte store.
        const body = result?.body;
        if (ArrayBuffer.isView(body) || body instanceof ArrayBuffer) {
          const bytes = ArrayBuffer.isView(body)
            ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
            : new Uint8Array(body);
          result = {
            ...result,
            body: putBytes(bytes),
          };
        }
      }
      const serializedResult = JSON.stringify(result);

      if (serializedResult === undefined) {
        throw new TypeError("Result is not JSON serializable");
      }

      // Only the body the result hands to the host stays open with the
      // invocation.
      if (streamResponseBody === true) {
        invocationRemainsOpen = responseBodyRegistry.retain(result?.stream);
      }
      return serializedResult;
    } finally {
      responseBodyRegistry.endCall();
      if (!invocationRemainsOpen) {
        clearInvocation();
      }
    }
  }

  // Pull from or cancel the response body a Fetch invocation left open. The
  // invocation ends with the body: on its last chunk, a cancel or an error.
  async function invokeResponseBody(operation, bodyId) {
    // Body pulls start in the empty async context; the stream's own promise
    // reactions keep theirs.
    globalThis.__fetchletAsyncContext?.set(undefined);
    let invocationEnds = true;

    try {
      if (operation === "pull") {
        const result = await responseBodyRegistry.pull(bodyId, true);
        invocationEnds = result.done;
        return JSON.stringify({
          chunk: putBytes(result.chunk),
          done: result.done,
        });
      }
      if (operation === "cancel") {
        // The client went away: the handler sees its request abort before
        // its body is cancelled.
        abortRequest();
        await responseBodyRegistry.cancel(bodyId);
        return "null";
      }
      throw new TypeError("Unknown response body operation");
    } finally {
      if (invocationEnds) {
        clearInvocation();
      }
    }
  }

  // The entry points Rust evaluates (execution/script.rs).
  Object.defineProperty(globalThis, "__fetchletInvocation", {
    value: Object.freeze({
      call: invokeExport,
      responseBody: invokeResponseBody,
    }),
    writable: false,
    configurable: false,
  });

  if (bindings.console) {
    installConsole();
  }

  const env = Object.assign(Object.create(null), bindings.env);
  for (const serviceName of bindings.services) {
    env[serviceName] = Object.freeze({
      fetch: (input, init) => hostFetch(input, init, serviceName),
    });
  }

  Object.defineProperty(globalThis, "fetchlet", {
    value: Object.freeze({
      env: Object.freeze(env),
      waitUntil,
    }),
    writable: false,
    configurable: false,
  });

  Object.defineProperty(globalThis, "__fetchletPumpHost", {
    value: pumpHostOperations,
    writable: false,
    configurable: false,
  });

  // A WebIDL operation: frameworks such as Next.js wrap the global fetch. A
  // replacement still reaches the host through this function, and the Rust
  // FetchPolicy authorizes every request it sends.
  Object.defineProperty(globalThis, "fetch", {
    value: (input, init) => hostFetch(input, init),
    writable: true,
    enumerable: true,
    configurable: true,
  });
})();
