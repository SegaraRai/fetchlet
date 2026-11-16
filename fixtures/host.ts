const host = globalThis as typeof globalThis & {
  fetchlet: {
    env: {
      MODE?: string;
      API: { fetch: typeof fetch };
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
    return { error: error.code ?? error.name };
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
    await fetch(url, { signal: controller.signal });
    return { aborted: false };
  } catch (error) {
    return { aborted: true, message: error.message };
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
    return { aborted: false };
  } catch (error) {
    return { aborted: true, message: error.message };
  } finally {
    clearTimeout(timer);
  }
}
