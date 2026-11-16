import { runtime } from "./runtime";

import "./blob";

class FormDataImpl {
  private data: [string, any][] = [];

  constructor(form?: unknown) {
    // HTMLFormElement is outside the server profile; only an omitted form is valid.
    if (form !== undefined) {
      throw new TypeError("FormData form elements are not supported in this profile");
    }
  }

  append(name: string, value: any, filename?: string) {
    if (value instanceof runtime.Blob) {
      const keepsOriginalFile = value instanceof runtime.File && filename === undefined;
      if (!keepsOriginalFile) {
        // XHR "create an entry" keeps a File's lastModified when renaming it.
        value = new runtime.File([value], filename ?? "blob", {
          type: value.type,
          ...(value instanceof runtime.File ? { lastModified: value.lastModified } : {}),
        });
      }
    } else {
      value = String(value);
    }
    this.data.push([String(name), value]);
  }

  get(name: string) {
    return this.data.find(([key]) => key === String(name))?.[1] ?? null;
  }

  getAll(name: string) {
    return this.data.filter(([key]) => key === String(name)).map(([, v]) => v);
  }

  has(name: string) {
    return this.data.some(([key]) => key === String(name));
  }

  delete(name: string) {
    name = String(name);
    for (let index = this.data.length - 1; index >= 0; index--) {
      if (this.data[index][0] === name) this.data.splice(index, 1);
    }
  }

  set(name: string, value: any, filename?: string) {
    const replacement = new FormDataImpl();
    replacement.append(name, value, filename);
    name = String(name);
    const index = this.data.findIndex(([key]) => key === name);
    if (index < 0) this.data.push(...replacement.data);
    else {
      this.data[index] = replacement.data[0];
      for (let position = this.data.length - 1; position > index; position--) {
        if (this.data[position][0] === name) this.data.splice(position, 1);
      }
    }
  }

  *entries(): IterableIterator<[string, any]> {
    yield* this.data;
  }

  *keys() {
    for (const [key] of this) {
      yield key;
    }
  }

  *values() {
    for (const [, value] of this) {
      yield value;
    }
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  forEach(fn: Function, thisArg?: any) {
    for (const [key, value] of this) {
      fn.call(thisArg, value, key, this);
    }
  }

  get [Symbol.toStringTag]() {
    return "FormData";
  }
}

Object.defineProperty(FormDataImpl, "name", { value: "FormData" });

runtime.FormData ??= FormDataImpl;

let boundaryId = 0;

export function multipart(data: Iterable<[string, any]>) {
  const boundary = "fetchlet-" + ++boundaryId;
  const parts: any[] = [];
  for (const [name, value] of data) {
    const escaped = (value: string) =>
      value.replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/"/g, "%22");
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${escaped(name)}"`);
    if (value instanceof runtime.File) {
      parts.push(
        `; filename="${escaped(value.name)}"\r\nContent-Type: ${value.type || "application/octet-stream"}`,
      );
    }
    parts.push("\r\n\r\n", value, "\r\n");
  }

  parts.push(`--${boundary}--\r\n`);
  return new runtime.Blob(parts, {
    type: `multipart/form-data; boundary=${boundary}`,
  });
}
