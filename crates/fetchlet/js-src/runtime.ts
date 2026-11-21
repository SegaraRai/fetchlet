globalThis.self = globalThis as typeof self;
globalThis.global = globalThis;

globalThis.console ??= {
  log() {},
  info() {},
  warn() {},
  error() {},
  debug() {},
} as Console;

globalThis.queueMicrotask ??= (callback: VoidFunction) => {
  void Promise.resolve().then(callback);
};
