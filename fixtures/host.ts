const host = globalThis as typeof globalThis & {
  fetchlet: {
    env: {
      MODE?: string;
      API: {
        fetch: typeof fetch;
      };
    };
  };
};

export async function fetchThroughHost(url: string, body?: number[]) {
  try {
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      body: body ? new Uint8Array(body) : undefined,
    });

    return {
      status: response.status,
      cookies: response.headers.getSetCookie(),
      data: await response.json(),
    };
  } catch (error) {
    return {
      error: error.code ?? error.name,
    };
  }
}

export async function fetchFromService(url: string) {
  const response = await host.fetchlet.env.API.fetch(url);
  return response.json();
}

export function hostEnvironment() {
  return {
    mode: host.fetchlet.env.MODE,
    names: Object.keys(host.fetchlet.env),
    frozen: Object.isFrozen(host.fetchlet.env),
  };
}

export async function abortHostFetch(url: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("cancelled")), 10);

  try {
    await fetch(url, {
      signal: controller.signal,
    });
    return {
      aborted: false,
    };
  } catch (error) {
    return {
      aborted: true,
      message: error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function leaveFetchUnfinished(url: string) {
  void fetch(url).catch(() => {});
  await Promise.resolve();
  return "started";
}

export async function abortRequestBody(url: string) {
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>();
  const timer = setTimeout(() => controller.abort(new Error("body cancelled")), 10);

  try {
    await fetch(url, {
      method: "POST",
      body,
      signal: controller.signal,
    });
    return {
      aborted: false,
    };
  } catch (error) {
    return {
      aborted: true,
      message: error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Read a host body that arrives in chunks: whole, as bytes, cloned or by chunks. */
export async function readChunkedBody(url: string, mode: string) {
  const response = await fetch(url);
  switch (mode) {
    case "text": {
      const text = await response.text();
      const again = await response.text().then(
        () => "read again",
        (error) => error.name,
      );
      return {
        text,
        used: response.bodyUsed,
        locked: response.body?.locked,
        again,
      };
    }

    case "arrayBuffer": {
      const buffer = await response.arrayBuffer();
      return {
        length: buffer.byteLength,
        text: new TextDecoder().decode(buffer),
      };
    }

    case "clone": {
      const copy = response.clone();
      return {
        texts: [await response.text(), await copy.text()],
      };
    }

    case "reader": {
      // Read by chunks, the body takes the stream path.
      const reader = response.body!.getReader();
      const chunks: string[] = [];
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        chunks.push(new TextDecoder().decode(next.value));
      }
      return {
        chunks,
      };
    }

    case "released": {
      // A lock released before any read leaves the body whole.
      response.body!.getReader().releaseLock();
      return {
        text: await response.text(),
      };
    }

    default:
      throw new TypeError("Unknown mode");
  }
}

/** Abort a host fetch while its body is read whole. */
export async function abortChunkedBody(url: string) {
  const controller = new AbortController();
  const response = await fetch(url, {
    signal: controller.signal,
  });
  const timer = setTimeout(() => controller.abort(new Error("body aborted")), 10);
  try {
    await response.text();
    return {
      aborted: false,
    };
  } catch (error) {
    return {
      aborted: true,
      message: error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}
