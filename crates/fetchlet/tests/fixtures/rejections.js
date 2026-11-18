// Records what the engine reports to the profile's rejection hooks.
const log = [];

globalThis.__fetchletPromiseRejection = (_promise, reason, handled) => {
  log.push(["track", String(reason), handled]);
};
globalThis.__fetchletFlushRejections = () => {
  log.push(["flush"]);
};

globalThis.fetchletExports = {
  takeLog: () => log.splice(0),
  unhandled: () => {
    void Promise.reject("lost");
    return null;
  },
  handledLater: async () => {
    const promise = Promise.reject("late");
    await Promise.resolve();
    promise.catch(() => {});
    return null;
  },
  fails: async () => {
    throw new Error("call");
  },
};
