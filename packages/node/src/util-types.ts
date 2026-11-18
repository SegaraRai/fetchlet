// node:util/types: the same functions as util.types.

import { types } from "./util.ts";

export const isPromise = types.isPromise;
export const isDate = types.isDate;
export const isRegExp = types.isRegExp;
export const isMap = types.isMap;
export const isSet = types.isSet;
export const isWeakMap = types.isWeakMap;
export const isWeakSet = types.isWeakSet;
export const isMapIterator = types.isMapIterator;
export const isSetIterator = types.isSetIterator;
export const isArrayBuffer = types.isArrayBuffer;
export const isSharedArrayBuffer = types.isSharedArrayBuffer;
export const isAnyArrayBuffer = types.isAnyArrayBuffer;
export const isArrayBufferView = types.isArrayBufferView;
export const isDataView = types.isDataView;
export const isTypedArray = types.isTypedArray;
export const isUint8Array = types.isUint8Array;
export const isUint8ClampedArray = types.isUint8ClampedArray;
export const isUint16Array = types.isUint16Array;
export const isUint32Array = types.isUint32Array;
export const isInt8Array = types.isInt8Array;
export const isInt16Array = types.isInt16Array;
export const isInt32Array = types.isInt32Array;
export const isFloat32Array = types.isFloat32Array;
export const isFloat64Array = types.isFloat64Array;
export const isBigInt64Array = types.isBigInt64Array;
export const isBigUint64Array = types.isBigUint64Array;
export const isAsyncFunction = types.isAsyncFunction;
export const isGeneratorFunction = types.isGeneratorFunction;
export const isGeneratorObject = types.isGeneratorObject;
export const isNativeError = types.isNativeError;
export const isBoxedPrimitive = types.isBoxedPrimitive;
export const isNumberObject = types.isNumberObject;
export const isStringObject = types.isStringObject;
export const isBooleanObject = types.isBooleanObject;
export const isBigIntObject = types.isBigIntObject;
export const isSymbolObject = types.isSymbolObject;
export const isProxy = types.isProxy;
export const isModuleNamespaceObject = types.isModuleNamespaceObject;
export const isExternal = types.isExternal;
export const isArgumentsObject = types.isArgumentsObject;
export const isKeyObject = types.isKeyObject;
export const isCryptoKey = types.isCryptoKey;

export default types;
