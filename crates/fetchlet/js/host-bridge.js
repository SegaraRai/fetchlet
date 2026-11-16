// Rust installs the host bindings before evaluating application code.
(() => {
  const nativeDispatch = globalThis.__fetchletHost;
  // Body bytes cross the bridge as typed arrays in the invocation's byte store;
  // JSON messages carry their handles.
  const takeBytes = globalThis.__fetchletTakeBytes;
  const putBytes = globalThis.__fetchletPutBytes;

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
    if (pendingFetches.size === 0 && pendingReads.size === 0) {
      return 0;
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

    return completions.length;
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

  const env = Object.assign(Object.create(null), bindings.env);
  for (const serviceName of bindings.services) {
    env[serviceName] = Object.freeze({
      fetch: (input, init) => hostFetch(input, init, serviceName),
    });
  }

  Object.defineProperty(globalThis, "fetchlet", {
    value: Object.freeze({
      env: Object.freeze(env),
    }),
    writable: false,
    configurable: false,
  });

  Object.defineProperty(globalThis, "__fetchletPumpHost", {
    value: pumpHostOperations,
    writable: false,
    configurable: false,
  });

  Object.defineProperty(globalThis, "fetch", {
    value: (input, init) => hostFetch(input, init),
    writable: false,
    configurable: false,
  });
})();
