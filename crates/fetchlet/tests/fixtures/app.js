const initialMode = fetchlet.env.MODE;

globalThis.fetchletExports = {
  echo: (value) => value,

  fail() {
    throw new Error("guest failure");
  },

  never: () => new Promise(() => {}),

  env: () => ({
    mode: initialMode,
    keys: Object.keys(fetchlet.env),
    frozen: Object.isFrozen(fetchlet.env),
  }),

  handle: (request, context) => ({
    status: 201,
    headers: [
      ["set-cookie", "a=1"],
      ["set-cookie", "b=2"],
      ...(context ? [["x-context", context.name]] : []),
    ],
    body: request.body ?? [],
  }),
};
