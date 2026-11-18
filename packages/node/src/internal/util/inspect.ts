// inspect, format and formatWithOptions. inspect follows Node's notation for
// the common value kinds; it does not reproduce every option and
// line-breaking rule of Node's implementation.

import { isTypedArray, tag, types } from "./types.ts";

export interface InspectOptions {
  depth?: number | null;
  colors?: boolean;
  showHidden?: boolean;
  compact?: boolean | number;
  breakLength?: number;
  sorted?: boolean;
  getters?: boolean;
}

const customInspect = Symbol.for("nodejs.util.inspect.custom");

function quote(text: string): string {
  const escaped = text.replace(/[\\\n\t\r\b\f\v\0]/g, (character) => {
    const escapes: Record<string, string> = {
      "\\": "\\\\",
      "\n": "\\n",
      "\t": "\\t",
      "\r": "\\r",
      "\b": "\\b",
      "\f": "\\f",
      "\v": "\\v",
      "\0": "\\x00",
    };
    return escapes[character];
  });
  if (!escaped.includes("'")) {
    return `'${escaped}'`;
  }
  if (!escaped.includes('"')) {
    return `"${escaped}"`;
  }
  if (!escaped.includes("`") && !escaped.includes("${")) {
    return `\`${escaped}\``;
  }
  return `'${escaped.replaceAll("'", "\\'")}'`;
}

function propertyKey(key: string | symbol): string {
  if (typeof key === "symbol") {
    return `[${key.toString()}]`;
  }
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : quote(key);
}

function functionName(fn: Function): string {
  const source = Function.prototype.toString.call(fn);
  const kind = source.startsWith("class")
    ? "class"
    : types.isAsyncFunction(fn)
      ? types.isGeneratorFunction(fn)
        ? "AsyncGeneratorFunction"
        : "AsyncFunction"
      : types.isGeneratorFunction(fn)
        ? "GeneratorFunction"
        : "Function";
  if (kind === "class") {
    return fn.name ? `[class ${fn.name}]` : "[class (anonymous)]";
  }
  return fn.name ? `[${kind}: ${fn.name}]` : `[${kind} (anonymous)]`;
}

function constructorName(value: object): string | null {
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) {
    return null;
  }
  const name = prototype.constructor?.name;
  return typeof name === "string" ? name : "Object";
}

interface InspectState {
  options: InspectOptions;
  seen: object[];
  circular: Map<object, number>;
  // Depth of the object formatted last, as Node's ctx.currentDepth.
  currentDepth: number;
}

// Node's defaults: entries past maxArrayLength are summarized, and up to
// `compact` inner levels share a line when it fits in breakLength.
const MAX_ARRAY_LENGTH = 100;
const COMPACT = 3;

/** Lays short array items out in aligned columns, as Node's groupArrayElements. */
function groupArrayElements(state: InspectState, output: string[], value: unknown, indent: number) {
  const breakLength = state.options.breakLength ?? 80;
  let totalLength = 0;
  let maxLength = 0;
  const hasMore = output.length > 0 && /^\.\.\. \d+ more items?$/.test(output[output.length - 1]);
  const outputLength = hasMore ? output.length - 1 : output.length;
  const separatorSpace = 2;
  const dataLength: number[] = [];
  for (let index = 0; index < outputLength; index += 1) {
    const length = output[index].length;
    dataLength.push(length);
    totalLength += length + separatorSpace;
    maxLength = Math.max(maxLength, length);
  }
  const actualMax = maxLength + separatorSpace;
  if (actualMax * 3 + indent < breakLength && (totalLength / actualMax > 5 || maxLength <= 6)) {
    const averageBias = Math.sqrt(actualMax - totalLength / output.length);
    const biasedMax = Math.max(actualMax - 3 - averageBias, 1);
    const columns = Math.min(
      Math.round(Math.sqrt(2.5 * biasedMax * outputLength) / biasedMax),
      Math.floor((breakLength - indent) / actualMax),
      COMPACT * 4,
      15,
    );
    if (columns <= 1) {
      return output;
    }
    const maxLineLength: number[] = [];
    for (let column = 0; column < columns; column += 1) {
      let lineLength = 0;
      for (let index = column; index < output.length; index += columns) {
        lineLength = Math.max(lineLength, dataLength[index] ?? 0);
      }
      maxLineLength.push(lineLength + separatorSpace);
    }
    const items = value as ArrayLike<unknown>;
    let padStart = true;
    for (let index = 0; index < output.length; index += 1) {
      if (typeof items[index] !== "number" && typeof items[index] !== "bigint") {
        padStart = false;
        break;
      }
    }
    const grouped: string[] = [];
    for (let start = 0; start < outputLength; start += columns) {
      const end = Math.min(start + columns, outputLength);
      let line = "";
      let index = start;
      for (; index < end - 1; index += 1) {
        const cell = `${output[index]}, `;
        const width = maxLineLength[index - start];
        line += padStart ? cell.padStart(width) : cell.padEnd(width);
      }
      line += padStart
        ? output[index].padStart(maxLineLength[index - start] - separatorSpace)
        : output[index];
      grouped.push(line);
    }
    if (hasMore) {
      grouped.push(output[outputLength]);
    }
    return grouped;
  }
  return output;
}

/** Joins the entries on one line when they fit, as Node's reduceToSingleString. */
function reduceToSingleString(
  state: InspectState,
  output: string[],
  open: string,
  close: string,
  depth: number,
  indent: string,
  array: unknown,
): string {
  const entries = output.length;
  if (array !== undefined && entries > 6) {
    output = groupArrayElements(state, output, array, indent.length);
  }
  if (state.currentDepth - depth < COMPACT && entries === output.length) {
    const start = output.length + indent.length + open.length + 10;
    const breakLength = state.options.breakLength ?? 80;
    const totalLength = output.reduce(
      (total, entry) => total + entry.length,
      output.length + start,
    );
    if (totalLength <= breakLength) {
      const joined = output.join(", ");
      if (!joined.includes("\n")) {
        return `${open} ${joined} ${close}`;
      }
    }
  }
  const lineIndent = `\n${indent}`;
  return `${open}${lineIndent}  ${output.join(`,${lineIndent}  `)}${lineIndent}${close}`;
}

function moreItems(remaining: number): string[] {
  return remaining > 0 ? [`... ${remaining} more item${remaining > 1 ? "s" : ""}`] : [];
}

function formatValue(
  value: unknown,
  state: InspectState,
  depth: number,
  indent: string,
  nested: boolean,
): string {
  const { options } = state;
  const maxDepth = options.depth === null ? Infinity : (options.depth ?? 2);
  switch (typeof value) {
    case "string":
      return nested ? quote(value) : value;

    case "number":
      return Object.is(value, -0) ? "-0" : String(value);

    case "bigint":
      return `${value}n`;

    case "boolean":
    case "undefined":
      return String(value);

    case "symbol":
      return value.toString();
  }
  if (value === null) {
    return "null";
  }
  const object = value as object;
  const custom = (object as { [customInspect]?: Function })[customInspect];
  if (typeof custom === "function" && custom !== inspect) {
    const result = custom.call(object, maxDepth - depth, options, inspect);
    return typeof result === "string" ? result : formatValue(result, state, depth, indent, nested);
  }
  if (state.seen.includes(object)) {
    let index = state.circular.get(object);
    if (index === undefined) {
      index = state.circular.size + 1;
      state.circular.set(object, index);
    }
    return `[Circular *${index}]`;
  }
  if (object instanceof Date) {
    return Number.isNaN(object.getTime()) ? "Invalid Date" : object.toISOString();
  }
  if (object instanceof RegExp) {
    return object.toString();
  }
  if (object instanceof Error) {
    return object.stack ?? `${object.name}: ${object.message}`;
  }
  if (typeof object === "function") {
    return functionName(object);
  }
  const name = constructorName(object);
  if (depth > maxDepth) {
    if (Array.isArray(object)) {
      return "[Array]";
    }
    return `[${name ?? "Object: null prototype"}]`;
  }
  state.seen.push(object);
  state.currentDepth = depth;
  const innerIndent = `${indent}  `;
  const next = (item: unknown) => formatValue(item, state, depth + 1, innerIndent, true);
  const ownEntries = (skipIndices: boolean) =>
    Reflect.ownKeys(object)
      .filter((key) => {
        if (skipIndices && typeof key === "string" && /^\d+$/.test(key)) {
          return false;
        }
        return Object.getOwnPropertyDescriptor(object, key)?.enumerable;
      })
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
        const shown =
          "value" in descriptor
            ? next(descriptor.value)
            : descriptor.get && descriptor.set
              ? "[Getter/Setter]"
              : descriptor.get
                ? "[Getter]"
                : "[Setter]";
        return `${propertyKey(key)}: ${shown}`;
      });
  const layout = (output: string[], open: string, close: string, array?: unknown) =>
    output.length === 0
      ? `${open}${close}`
      : reduceToSingleString(state, output, open, close, depth, indent, array);
  let result: string;
  if (Array.isArray(object)) {
    const items = object.slice(0, MAX_ARRAY_LENGTH).map((item) => next(item));
    const prefix =
      name === "Array" ? "" : `${name ?? "[Array: null prototype]"}(${object.length}) `;
    result = layout(
      [...items, ...moreItems(object.length - MAX_ARRAY_LENGTH), ...ownEntries(true)],
      `${prefix}[`,
      "]",
      object,
    );
  } else if (object instanceof Map) {
    const items = [...object]
      .slice(0, MAX_ARRAY_LENGTH)
      .map(([key, item]) => `${next(key)} => ${next(item)}`);
    result = layout(
      [...items, ...moreItems(object.size - MAX_ARRAY_LENGTH), ...ownEntries(false)],
      `Map(${object.size}) {`,
      "}",
    );
  } else if (object instanceof Set) {
    const items = [...object].slice(0, MAX_ARRAY_LENGTH).map((item) => next(item));
    result = layout(
      [...items, ...moreItems(object.size - MAX_ARRAY_LENGTH), ...ownEntries(false)],
      `Set(${object.size}) {`,
      "}",
    );
  } else if (isTypedArray(object)) {
    const all = object as unknown as ArrayLike<number | bigint>;
    const items = Array.from(all, (item) => (typeof item === "bigint" ? `${item}n` : String(item)));
    result = layout(
      [...items.slice(0, MAX_ARRAY_LENGTH), ...moreItems(all.length - MAX_ARRAY_LENGTH)],
      `${name}(${all.length}) [`,
      "]",
      object,
    );
  } else if (object instanceof ArrayBuffer) {
    const bytes = Array.from(new Uint8Array(object), (byte) => byte.toString(16).padStart(2, "0"));
    result = `ArrayBuffer { [Uint8Contents]: <${bytes.join(" ")}>, byteLength: ${object.byteLength} }`;
  } else if (object instanceof Promise) {
    result = "Promise { <unknown> }";
  } else if (types.isBoxedPrimitive(object)) {
    const primitive = (object as { valueOf(): unknown }).valueOf();
    result = `[${tag(object)}: ${formatValue(primitive, state, depth, indent, true)}]`;
  } else {
    const prefix =
      name === "Object" ? "" : name === null ? "[Object: null prototype] " : `${name} `;
    result = layout(ownEntries(false), `${prefix}{`, "}");
  }
  state.seen.pop();
  const reference = state.circular.get(object);
  return reference === undefined ? result : `<ref *${reference}> ${result}`;
}

function newState(options: InspectOptions): InspectState {
  return {
    options,
    seen: [],
    circular: new Map(),
    currentDepth: 0,
  };
}

/**
 * Whether `value` uses a toString of a built-in class, as Node decides for
 * %s: objects with their own toString are converted with String instead.
 */
function hasBuiltInToString(value: object): boolean {
  if (typeof (value as { toString?: unknown }).toString !== "function") {
    return true;
  }
  if (Object.hasOwn(value, "toString")) {
    return false;
  }
  let pointer: object | null = value;
  do {
    pointer = Object.getPrototypeOf(pointer);
  } while (pointer !== null && !Object.hasOwn(pointer, "toString"));
  if (pointer === null) {
    return true;
  }
  const constructor = Object.getOwnPropertyDescriptor(pointer, "constructor")?.value;
  return (
    typeof constructor === "function" &&
    (globalThis as Record<string, unknown>)[constructor.name] === constructor
  );
}

export const inspect = Object.assign(
  function inspect(value: unknown, options?: InspectOptions | boolean): string {
    const resolved: InspectOptions = typeof options === "object" && options !== null ? options : {};
    return formatValue(value, newState(resolved), 0, "", true);
  },
  {
    custom: customInspect,
    defaultOptions: {
      depth: 2,
      colors: false,
      showHidden: false,
      breakLength: 80,
    } as InspectOptions,
    colors: {} as Record<string, [number, number]>,
    styles: {} as Record<string, string>,
  },
);

export function formatWithOptions(options: InspectOptions, ...args: unknown[]): string {
  const first = args[0];
  let result = "";
  let index = 0;
  if (typeof first === "string") {
    index = 1;
    let last = 0;
    for (let position = 0; position < first.length - 1; position += 1) {
      if (first[position] !== "%") {
        continue;
      }
      const directive = first[position + 1];
      if (directive === "%") {
        result += first.slice(last, position) + "%";
        last = position + 2;
        position += 1;
        continue;
      }
      if (!"sdifjoOc".includes(directive) || index >= args.length) {
        continue;
      }
      const argument = args[index++];
      let text: string;
      switch (directive) {
        case "s":
          text =
            typeof argument === "bigint"
              ? `${argument}n`
              : typeof argument === "number"
                ? formatValue(argument, newState(options), 0, "", false)
                : typeof argument === "object" && argument !== null
                  ? hasBuiltInToString(argument)
                    ? inspect(argument, {
                        ...options,
                        depth: 0,
                      })
                    : // eslint-disable-next-line typescript/no-base-to-string -- %s uses the object's own toString, as Node's does.
                      String(argument)
                  : typeof argument === "symbol"
                    ? argument.toString()
                    : String(argument);
          break;

        case "d":
        case "i": {
          if (typeof argument === "bigint") {
            text = `${argument}n`;
          } else if (typeof argument === "symbol") {
            text = "NaN";
          } else {
            const number = Number(argument);
            text = String(directive === "i" ? Math.trunc(number) : number);
          }
          break;
        }

        case "f":
          text = typeof argument === "symbol" ? "NaN" : String(Number.parseFloat(String(argument)));
          break;

        case "j":
          try {
            text = JSON.stringify(argument) ?? "undefined";
          } catch {
            text = "[Circular]";
          }
          break;

        case "o":
          text = inspect(argument, {
            ...options,
            showHidden: true,
            depth: 4,
          });
          break;

        case "O":
          text = inspect(argument, options);
          break;

        default:
          text = "";
          break;
      }
      result += first.slice(last, position) + text;
      last = position + 2;
      position += 1;
    }
    result += first.slice(last);
  }
  for (; index < args.length; index += 1) {
    const argument = args[index];
    if (result.length > 0 || index > 0) {
      result += " ";
    }
    result += typeof argument === "string" ? argument : inspect(argument, options);
  }
  return result;
}

export function format(...args: unknown[]): string {
  return formatWithOptions({}, ...args);
}
