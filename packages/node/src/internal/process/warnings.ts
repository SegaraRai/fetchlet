// Process warnings for modules that cannot import node:process, which
// itself imports node:events. node:process installs its emitWarning here
// when it is part of the artifact; until then warnings go to console.error
// in the form process prints for warnings without listeners.

type EmitWarning = (warning: string | Error, type?: string, code?: string) => void;

let sink: EmitWarning = (warning, type) => {
  const name = typeof warning === "string" ? (type ?? "Warning") : warning.name;
  const message = typeof warning === "string" ? warning : warning.message;
  globalThis.console?.error?.(`(fetchlet) ${name}: ${message}`);
};

export function emitWarning(warning: string | Error, type?: string, code?: string): void {
  sink(warning, type, code);
}

export function setWarningSink(emit: EmitWarning): void {
  sink = emit;
}
