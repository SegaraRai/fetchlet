globalThis.self = globalThis;
globalThis.global = globalThis;

globalThis.console ??= {
  log() {},
  info() {},
  warn() {},
  error() {},
  debug() {},
};

globalThis.queueMicrotask ??= (callback) => {
  Promise.resolve().then(callback);
};
