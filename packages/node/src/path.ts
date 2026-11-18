// node:path with Node's POSIX semantics, after lib/path.js. The working
// directory of `resolve` is the process's, "/". Windows paths are outside
// the instance, so `win32` is not provided.

import { invalidArgType } from "./errors.ts";

const SLASH = 47;
const DOT = 46;

function validateString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string") {
    throw invalidArgType(name, "of type string", value);
  }
}

/** Resolves "." and ".." segments; `allowAboveRoot` keeps leading "..". */
function normalizeString(path: string, allowAboveRoot: boolean): string {
  let result = "";
  let lastSegmentLength = 0;
  let lastSlash = -1;
  let dots = 0;
  let code = 0;
  for (let index = 0; index <= path.length; index += 1) {
    if (index < path.length) {
      code = path.charCodeAt(index);
    } else if (code === SLASH) {
      break;
    } else {
      code = SLASH;
    }
    if (code === SLASH) {
      if (lastSlash === index - 1 || dots === 1) {
        // An empty or "." segment.
      } else if (dots === 2) {
        if (
          result.length < 2 ||
          lastSegmentLength !== 2 ||
          result.charCodeAt(result.length - 1) !== DOT ||
          result.charCodeAt(result.length - 2) !== DOT
        ) {
          if (result.length > 2) {
            const lastSlashIndex = result.lastIndexOf("/");
            if (lastSlashIndex === -1) {
              result = "";
              lastSegmentLength = 0;
            } else {
              result = result.slice(0, lastSlashIndex);
              lastSegmentLength = result.length - 1 - result.lastIndexOf("/");
            }
            lastSlash = index;
            dots = 0;
            continue;
          } else if (result.length !== 0) {
            result = "";
            lastSegmentLength = 0;
            lastSlash = index;
            dots = 0;
            continue;
          }
        }
        if (allowAboveRoot) {
          result += result.length > 0 ? "/.." : "..";
          lastSegmentLength = 2;
        }
      } else {
        const segment = path.slice(lastSlash + 1, index);
        result = result.length > 0 ? `${result}/${segment}` : segment;
        lastSegmentLength = index - lastSlash - 1;
      }
      lastSlash = index;
      dots = 0;
    } else if (code === DOT && dots !== -1) {
      dots += 1;
    } else {
      dots = -1;
    }
  }
  return result;
}

export const sep = "/";
export const delimiter = ":";

export function resolve(...paths: string[]): string {
  let resolved = "";
  let absolute = false;
  for (let index = paths.length - 1; index >= -1 && !absolute; index -= 1) {
    const path = index >= 0 ? paths[index] : "/";
    validateString(path, `paths[${index}]`);
    if (path.length === 0) {
      continue;
    }
    resolved = `${path}/${resolved}`;
    absolute = path.charCodeAt(0) === SLASH;
  }
  resolved = normalizeString(resolved, !absolute);
  if (absolute) {
    return `/${resolved}`;
  }
  return resolved.length > 0 ? resolved : ".";
}

export function normalize(path: string): string {
  validateString(path, "path");
  if (path.length === 0) {
    return ".";
  }
  const absolute = path.charCodeAt(0) === SLASH;
  const trailing = path.charCodeAt(path.length - 1) === SLASH;
  let result = normalizeString(path, !absolute);
  if (result.length === 0) {
    if (absolute) {
      return "/";
    }
    return trailing ? "./" : ".";
  }
  if (trailing) {
    result += "/";
  }
  return absolute ? `/${result}` : result;
}

export function isAbsolute(path: string): boolean {
  validateString(path, "path");
  return path.length > 0 && path.charCodeAt(0) === SLASH;
}

export function join(...paths: string[]): string {
  if (paths.length === 0) {
    return ".";
  }
  let joined: string | undefined;
  for (const path of paths) {
    validateString(path, "path");
    if (path.length > 0) {
      joined = joined === undefined ? path : `${joined}/${path}`;
    }
  }
  return joined === undefined ? "." : normalize(joined);
}

export function relative(from: string, to: string): string {
  validateString(from, "from");
  validateString(to, "to");
  if (from === to) {
    return "";
  }
  from = resolve(from);
  to = resolve(to);
  if (from === to) {
    return "";
  }
  const fromStart = 1;
  const fromEnd = from.length;
  const fromLength = fromEnd - fromStart;
  const toStart = 1;
  const toLength = to.length - toStart;
  const length = fromLength < toLength ? fromLength : toLength;
  let lastCommonSlash = -1;
  let index = 0;
  for (; index < length; index += 1) {
    const code = from.charCodeAt(fromStart + index);
    if (code !== to.charCodeAt(toStart + index)) {
      break;
    } else if (code === SLASH) {
      lastCommonSlash = index;
    }
  }
  if (index === length) {
    if (toLength > length) {
      if (to.charCodeAt(toStart + index) === SLASH) {
        return to.slice(toStart + index + 1);
      }
      if (index === 0) {
        return to.slice(toStart + index);
      }
    } else if (fromLength > length) {
      if (from.charCodeAt(fromStart + index) === SLASH) {
        lastCommonSlash = index;
      } else if (index === 0) {
        lastCommonSlash = 0;
      }
    }
  }
  let out = "";
  for (index = fromStart + lastCommonSlash + 1; index <= fromEnd; index += 1) {
    if (index === fromEnd || from.charCodeAt(index) === SLASH) {
      out += out.length === 0 ? ".." : "/..";
    }
  }
  return `${out}${to.slice(toStart + lastCommonSlash)}`;
}

export function toNamespacedPath(path: string): string {
  return path;
}

export function dirname(path: string): string {
  validateString(path, "path");
  if (path.length === 0) {
    return ".";
  }
  const absolute = path.charCodeAt(0) === SLASH;
  let end = -1;
  let matchedSlash = true;
  for (let index = path.length - 1; index >= 1; index -= 1) {
    if (path.charCodeAt(index) === SLASH) {
      if (!matchedSlash) {
        end = index;
        break;
      }
    } else {
      matchedSlash = false;
    }
  }
  if (end === -1) {
    return absolute ? "/" : ".";
  }
  if (absolute && end === 1) {
    return "//";
  }
  return path.slice(0, end);
}

export function basename(path: string, suffix?: string): string {
  if (suffix !== undefined) {
    validateString(suffix, "suffix");
  }
  validateString(path, "path");
  let start = 0;
  let end = -1;
  let matchedSlash = true;
  if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
    if (suffix === path) {
      return "";
    }
    let suffixIndex = suffix.length - 1;
    let firstNonSlashEnd = -1;
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const code = path.charCodeAt(index);
      if (code === SLASH) {
        if (!matchedSlash) {
          start = index + 1;
          break;
        }
      } else {
        if (firstNonSlashEnd === -1) {
          matchedSlash = false;
          firstNonSlashEnd = index + 1;
        }
        if (suffixIndex >= 0) {
          if (code === suffix.charCodeAt(suffixIndex)) {
            suffixIndex -= 1;
            if (suffixIndex === -1) {
              end = index;
            }
          } else {
            suffixIndex = -1;
            end = firstNonSlashEnd;
          }
        }
      }
    }
    if (start === end) {
      end = firstNonSlashEnd;
    } else if (end === -1) {
      end = path.length;
    }
    return path.slice(start, end);
  }
  for (let index = path.length - 1; index >= 0; index -= 1) {
    if (path.charCodeAt(index) === SLASH) {
      if (!matchedSlash) {
        start = index + 1;
        break;
      }
    } else if (end === -1) {
      matchedSlash = false;
      end = index + 1;
    }
  }
  return end === -1 ? "" : path.slice(start, end);
}

export function extname(path: string): string {
  validateString(path, "path");
  let startDot = -1;
  let startPart = 0;
  let end = -1;
  let matchedSlash = true;
  // 0: no dot yet, 1: a dot in the segment, -1: a non-dot after it.
  let preDotState = 0;
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const code = path.charCodeAt(index);
    if (code === SLASH) {
      if (!matchedSlash) {
        startPart = index + 1;
        break;
      }
      continue;
    }
    if (end === -1) {
      matchedSlash = false;
      end = index + 1;
    }
    if (code === DOT) {
      if (startDot === -1) {
        startDot = index;
      } else if (preDotState !== 1) {
        preDotState = 1;
      }
    } else if (startDot !== -1) {
      preDotState = -1;
    }
  }
  if (
    startDot === -1 ||
    end === -1 ||
    preDotState === 0 ||
    (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
  ) {
    return "";
  }
  return path.slice(startDot, end);
}

interface ParsedPath {
  root: string;
  dir: string;
  base: string;
  ext: string;
  name: string;
}

export function format(pathObject: Partial<ParsedPath>): string {
  if (pathObject === null || typeof pathObject !== "object") {
    throw invalidArgType("pathObject", "of type object", pathObject);
  }
  const dir = pathObject.dir || pathObject.root;
  const base =
    pathObject.base ||
    `${pathObject.name || ""}${pathObject.ext && !pathObject.ext.startsWith(".") ? "." : ""}${pathObject.ext || ""}`;
  if (!dir) {
    return base;
  }
  return dir === pathObject.root ? `${dir}${base}` : `${dir}/${base}`;
}

export function parse(path: string): ParsedPath {
  validateString(path, "path");
  const result: ParsedPath = { root: "", dir: "", base: "", ext: "", name: "" };
  if (path.length === 0) {
    return result;
  }
  const absolute = path.charCodeAt(0) === SLASH;
  let start = 0;
  if (absolute) {
    result.root = "/";
    start = 1;
  }
  let startDot = -1;
  let startPart = 0;
  let end = -1;
  let matchedSlash = true;
  let index = path.length - 1;
  let preDotState = 0;
  for (; index >= start; index -= 1) {
    const code = path.charCodeAt(index);
    if (code === SLASH) {
      if (!matchedSlash) {
        startPart = index + 1;
        break;
      }
      continue;
    }
    if (end === -1) {
      matchedSlash = false;
      end = index + 1;
    }
    if (code === DOT) {
      if (startDot === -1) {
        startDot = index;
      } else if (preDotState !== 1) {
        preDotState = 1;
      }
    } else if (startDot !== -1) {
      preDotState = -1;
    }
  }
  if (end !== -1) {
    const partStart = startPart === 0 && absolute ? 1 : startPart;
    if (
      startDot === -1 ||
      preDotState === 0 ||
      (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
    ) {
      result.base = result.name = path.slice(partStart, end);
    } else {
      result.name = path.slice(partStart, startDot);
      result.base = path.slice(partStart, end);
      result.ext = path.slice(startDot, end);
    }
  }
  if (startPart > 0) {
    result.dir = path.slice(0, startPart - 1);
  } else if (absolute) {
    result.dir = "/";
  }
  return result;
}

export function matchesGlob(): never {
  throw Object.assign(new Error("path.matchesGlob is not available in fetchlet"), {
    code: "ERR_METHOD_NOT_IMPLEMENTED",
  });
}

const path = {
  sep,
  delimiter,
  resolve,
  normalize,
  isAbsolute,
  join,
  relative,
  toNamespacedPath,
  dirname,
  basename,
  extname,
  format,
  parse,
  matchesGlob,
  posix: undefined as unknown,
};
path.posix = path;

export const posix = path;
export default path;
