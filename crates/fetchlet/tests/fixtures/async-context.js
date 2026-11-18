// A minimal AsyncContext.Variable over the engine's slot,
// `__fetchletAsyncContext`, without the Web API profile. Each export reports
// what its code observed; the expected values are Node's results for the
// same programs with AsyncLocalStorage.

const slot = globalThis.__fetchletAsyncContext;

const current = () => {
  const mapping = slot.get();
  return mapping instanceof Map ? mapping : new Map();
};

class Variable {
  get() {
    return current().get(this);
  }

  run(value, callback) {
    const previous = slot.get();
    const next = new Map(current());
    next.set(this, value);
    slot.set(next);
    try {
      return callback();
    } finally {
      slot.set(previous);
    }
  }

  enter(value) {
    const next = new Map(current());
    next.set(this, value);
    slot.set(next);
  }
}

const variable = new Variable();
const tick = () => Promise.resolve();

globalThis.fetchletExports = {
  hasSlot: () => slot !== undefined,

  // Two runs started together each see only their own value after awaits.
  concurrentRuns: async () => {
    const reader = (value) =>
      variable.run(value, async () => {
        const seen = [];
        for (let turn = 0; turn < 3; turn += 1) {
          await tick();
          seen.push(variable.get());
        }
        return seen;
      });
    return Promise.all([reader("a"), reader("b")]);
  },

  // A then callback runs in the context of its registration.
  thenRegistration: async () => {
    let resolve;
    const promise = new Promise((settle) => {
      resolve = settle;
    });
    const seen = variable.run("registered", () => promise.then(() => variable.get()));
    variable.run("resolved", () => resolve());
    return seen;
  },

  // A thenable's then method runs in the context of the await that took it.
  thenable: async () => {
    const thenable = {
      then(resolve) {
        resolve(variable.get());
      },
    };
    return variable.run("awaited", async () => await thenable);
  },

  // An async generator resumes in the context of each next() call.
  asyncGenerator: async () => {
    async function* generate() {
      yield variable.get();
      await tick();
      yield variable.get();
    }
    const iterator = variable.run("created", () => generate());
    const first = await variable.run("first", () => iterator.next());
    const second = await variable.run("second", () => iterator.next());
    return [first.value, second.value];
  },

  // for await keeps the loop's context across iterations.
  forAwait: async () => {
    async function* numbers() {
      yield 1;
      await tick();
      yield 2;
    }
    return variable.run("loop", async () => {
      const seen = [];
      for await (const number of numbers()) {
        await tick();
        seen.push([number, variable.get()]);
      }
      return seen;
    });
  },

  // enterWith lasts across later awaits of the same run, and not past it.
  enterWithinRun: async () => {
    const inner = await variable.run("outer", async () => {
      await tick();
      variable.enter("entered");
      await tick();
      return variable.get();
    });
    return [inner, variable.get() ?? null];
  },

  // A value entered at the top level of one invocation does not reach the next.
  leaveEntered: () => {
    variable.enter("leaked");
    return variable.get();
  },
  readEntered: async () => {
    await tick();
    return variable.get() ?? null;
  },
};
