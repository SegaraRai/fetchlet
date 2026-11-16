async function invokeExport(exportName, argumentsList) {
  const exports = globalThis.fetchletExports;

  if (!Object.hasOwn(exports, exportName)) {
    throw new TypeError("Unknown function");
  }

  const exportedFunction = exports[exportName];
  if (typeof exportedFunction !== "function") {
    throw new TypeError("Unknown function");
  }

  const result = await exportedFunction(...argumentsList);
  const serializedResult = JSON.stringify(result);

  if (serializedResult === undefined) {
    throw new TypeError("Result is not JSON serializable");
  }

  return serializedResult;
}
