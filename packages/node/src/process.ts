// node:process and the `process` global: an EventEmitter with the properties
// libraries read, for an instance that has no operating-system process of its
// own.

export {
  arch,
  argv,
  argv0,
  config,
  cpuUsage,
  cwd,
  process as default,
  emitWarning,
  env,
  execArgv,
  execPath,
  exit,
  features,
  hrtime,
  memoryUsage,
  nextTick,
  pid,
  platform,
  ppid,
  release,
  stderr,
  stdout,
  title,
  uptime,
  version,
  versions,
} from "./internal/process/process.ts";
