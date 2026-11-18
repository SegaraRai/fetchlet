// The value checks of util.types and node:util/types.

const toString = (value: unknown) => Object.prototype.toString.call(value);
export const tag = (value: unknown) => toString(value).slice(8, -1);

const TypedArray = Object.getPrototypeOf(Uint8Array) as Function;

export function isTypedArray(value: unknown): value is ArrayBufferView {
  return value instanceof TypedArray;
}

function typed(name: string) {
  return (value: unknown) => isTypedArray(value) && tag(value) === name;
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const GeneratorFunction = Object.getPrototypeOf(function* () {}).constructor;
const AsyncGeneratorFunction = Object.getPrototypeOf(async function* () {}).constructor;

export const isPromise = (value: unknown) => value instanceof Promise;
export const isDate = (value: unknown) => value instanceof Date;
export const isRegExp = (value: unknown) => value instanceof RegExp;
export const isMap = (value: unknown) => value instanceof Map;
export const isSet = (value: unknown) => value instanceof Set;
export const isWeakMap = (value: unknown) => value instanceof WeakMap;
export const isWeakSet = (value: unknown) => value instanceof WeakSet;
export const isMapIterator = (value: unknown) => tag(value) === "Map Iterator";
export const isSetIterator = (value: unknown) => tag(value) === "Set Iterator";
export const isArrayBuffer = (value: unknown) => value instanceof ArrayBuffer;
export const isSharedArrayBuffer = (value: unknown) => tag(value) === "SharedArrayBuffer";
export const isAnyArrayBuffer = (value: unknown) =>
  value instanceof ArrayBuffer || tag(value) === "SharedArrayBuffer";
export const isArrayBufferView = (value: unknown) => ArrayBuffer.isView(value);
export const isDataView = (value: unknown) => value instanceof DataView;
export const isUint8Array = typed("Uint8Array");
export const isUint8ClampedArray = typed("Uint8ClampedArray");
export const isUint16Array = typed("Uint16Array");
export const isUint32Array = typed("Uint32Array");
export const isInt8Array = typed("Int8Array");
export const isInt16Array = typed("Int16Array");
export const isInt32Array = typed("Int32Array");
export const isFloat32Array = typed("Float32Array");
export const isFloat64Array = typed("Float64Array");
export const isBigInt64Array = typed("BigInt64Array");
export const isBigUint64Array = typed("BigUint64Array");
export const isAsyncFunction = (value: unknown) =>
  value instanceof AsyncFunction || value instanceof AsyncGeneratorFunction;
export const isGeneratorFunction = (value: unknown) =>
  value instanceof GeneratorFunction || value instanceof AsyncGeneratorFunction;
export const isGeneratorObject = (value: unknown) => tag(value) === "Generator";
export const isNativeError = (value: unknown) => value instanceof Error;
export const isBoxedPrimitive = (value: unknown) =>
  value instanceof Number ||
  value instanceof String ||
  value instanceof Boolean ||
  (typeof value === "object" && value !== null && ["BigInt", "Symbol"].includes(tag(value)));
export const isNumberObject = (value: unknown) => value instanceof Number;
export const isStringObject = (value: unknown) => value instanceof String;
export const isBooleanObject = (value: unknown) => value instanceof Boolean;
export const isBigIntObject = (value: unknown) =>
  typeof value === "object" && tag(value) === "BigInt";
export const isSymbolObject = (value: unknown) =>
  typeof value === "object" && tag(value) === "Symbol";
export const isProxy = (_value: unknown) => false;
export const isModuleNamespaceObject = (value: unknown) => tag(value) === "Module";
export const isExternal = (_value: unknown) => false;
export const isArgumentsObject = (value: unknown) => tag(value) === "Arguments";
export const isKeyObject = (value: unknown) => tag(value) === "KeyObject";
export const isCryptoKey = (value: unknown) => tag(value) === "CryptoKey";

export const types = {
  isPromise,
  isDate,
  isRegExp,
  isMap,
  isSet,
  isWeakMap,
  isWeakSet,
  isMapIterator,
  isSetIterator,
  isArrayBuffer,
  isSharedArrayBuffer,
  isAnyArrayBuffer,
  isArrayBufferView,
  isDataView,
  isTypedArray,
  isUint8Array,
  isUint8ClampedArray,
  isUint16Array,
  isUint32Array,
  isInt8Array,
  isInt16Array,
  isInt32Array,
  isFloat32Array,
  isFloat64Array,
  isBigInt64Array,
  isBigUint64Array,
  isAsyncFunction,
  isGeneratorFunction,
  isGeneratorObject,
  isNativeError,
  isBoxedPrimitive,
  isNumberObject,
  isStringObject,
  isBooleanObject,
  isBigIntObject,
  isSymbolObject,
  isProxy,
  isModuleNamespaceObject,
  isExternal,
  isArgumentsObject,
  isKeyObject,
  isCryptoKey,
};
