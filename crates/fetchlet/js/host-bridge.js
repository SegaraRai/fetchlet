// Rust installs the host bindings before evaluating application code.
(() => {
  const nativeDispatch = globalThis.__fetchletHost;
  const pendingFetches = new Map();

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

    return Array.from(bytes);
  }

  function responseFromWire(response) {
    const hasNoBody = [204, 205, 304].includes(response.status);
    const body = hasNoBody ? null : new Uint8Array(response.body);

    return new Response(body, {
      status: response.status,
      headers: response.headers,
    });
  }

  function pumpHostOperations() {
    if (pendingFetches.size === 0) {
      return 0;
    }

    const completions = dispatch("fetch.poll", null);
    for (const completion of completions) {
      const pending = pendingFetches.get(completion.id);
      if (!pending) {
        continue;
      }

      pendingFetches.delete(completion.id);
      pending.cleanup();

      if (completion.result.ok) {
        pending.resolve(responseFromWire(completion.result.value));
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

    const ticket = dispatch("fetch.start", {
      service: service ?? null,
      redirect: request.redirect,
      request: {
        url: request.url,
        method: request.method,
        headers: Array.from(request.headers),
        body,
      },
    });

    return waitForResponse(ticket, request.signal);
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
