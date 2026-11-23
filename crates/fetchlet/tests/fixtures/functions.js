const DB = fetchlet.env.DB;

/** What a failed call threw, by the properties JavaScript sees. */
function failure(error) {
  return {
    name: error.name,
    message: error.message,
    code: error.code ?? null,
    type: error instanceof TypeError,
  };
}

async function settle(call) {
  try {
    return { value: await call() };
  } catch (error) {
    return failure(error);
  }
}

globalThis.fetchletExports = {
  ping: () => "pong",

  shape() {
    const descriptor = Object.getOwnPropertyDescriptor(fetchlet.env, "DB");
    return {
      keys: Object.keys(DB),
      frozen: Object.isFrozen(DB),
      prototype: Object.getPrototypeOf(DB) === null,
      envKeys: Object.keys(fetchlet.env),
      writable: descriptor.writable,
    };
  },

  async calls() {
    const pending = DB.add(2, 3);
    const escaped = DB.escape("it's");
    return {
      promise: pending instanceof Promise,
      sum: await pending,
      escaped,
      // undefined arguments cross as null; a method may take any number.
      echoed: await DB.echo(undefined, null, { nested: [1, "two"] }),
      // A sync method's result is returned at once.
      empty: DB.nothing(),
      parallel: await Promise.all([DB.add(1, 1), DB.add(2, 2), DB.add(3, 3)]),
      method: DB.method(),
    };
  },

  async errors() {
    const sync = (call) => {
      try {
        return { value: call() };
      } catch (error) {
        return failure(error);
      }
    };
    return {
      application: await settle(() => DB.find("nobody")),
      uncoded: sync(() => DB.fail()),
      asyncArguments: await settle(() => DB.add("two", 3)),
      syncArguments: sync(() => DB.escape(1)),
      missing: sync(() => DB.escape()),
      extra: sync(() => DB.escape("a", "b")),
      host: await settle(() => DB.denied()),
      panicked: sync(() => DB.panics()),
      asyncPanicked: await settle(() => DB.panicsLater()),
      unencodable: sync(() => DB.echoSync(1n)),
      tooLarge: await settle(() => DB.large()),
    };
  },

  async limited() {
    const outcomes = [];
    for (const call of [
      () => DB.add(1, 2),
      () => DB.escape("x"),
      () => DB.add(3, 4),
      () => DB.escape("y"),
    ]) {
      outcomes.push(await settle(async () => call()));
    }
    return outcomes.map((outcome) => outcome.code ?? "ok");
  },

  // Leave a call running when the invocation ends.
  leave() {
    void DB.forever().catch(() => {});
    return "returned";
  },

  wait: () => DB.forever(),

  async reenter() {
    return {
      async: await settle(() => DB.reenter()),
      sync: (() => {
        try {
          return { value: DB.reenterSync() };
        } catch (error) {
          return failure(error);
        }
      })(),
    };
  },

  async handle() {
    const caller = await DB.whoami();
    const body = new Uint8Array(Array.from(caller, (character) => character.charCodeAt(0)));
    return { status: 200, headers: [], body };
  },
};
