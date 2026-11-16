export function handleError({ error }) {
  ((globalThis as any).fetchletDiagnostics ??= []).push(String(error?.stack ?? error));
  return {
    message: String(error?.message ?? error),
  };
}
