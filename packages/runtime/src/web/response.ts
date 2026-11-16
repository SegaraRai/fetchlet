import { runtime } from "./runtime";
import { BodyImpl } from "./body";
import { byteString, dictionary, unsignedShort } from "./idl";
import { makeHeadersImmutable } from "./headers";

class ResponseImpl extends BodyImpl {
  status: number;
  statusText: string;
  url = "";
  redirected = false;
  type = "default";

  constructor(body?: any, init: any = {}) {
    init = dictionary(init);
    const status = unsignedShort(init.status === undefined ? 200 : init.status);
    const statusText = byteString(init.statusText === undefined ? "" : init.statusText);
    if (status < 200 || status > 599) {
      throw new RangeError("Invalid status");
    }
    if (/[^\x09\x20-\x7e\x80-\xff]/.test(statusText)) {
      throw new TypeError("Invalid status text");
    }
    if (body != null && [204, 205, 304].includes(status)) {
      throw new TypeError("Null body status");
    }
    super(body, init.headers);
    this.status = status;
    this.statusText = statusText;
  }

  get ok() {
    return this.status >= 200 && this.status < 300;
  }

  clone() {
    const response = new ResponseImpl(this.cloneStream(), {
      status: this.status === 0 ? 200 : this.status,
      statusText: this.statusText,
      headers: this.headers,
    });
    response.status = this.status;
    response.type = this.type;
    response.url = this.url;
    response.redirected = this.redirected;
    if (this.type === "error" || this.immutable) {
      response.freezeHeaders();
    }
    return response;
  }

  private immutable = false;

  private freezeHeaders() {
    this.immutable = true;
    makeHeadersImmutable(this.headers);
  }

  static error() {
    const response = new ResponseImpl();
    response.status = 0;
    response.type = "error";
    response.freezeHeaders();
    return response;
  }

  static json(value: any, init: any = {}) {
    if (arguments.length === 0) {
      throw new TypeError("Response.json requires a value");
    }
    const text = JSON.stringify(value);
    if (text === undefined) {
      throw new TypeError("Value is not JSON serializable");
    }
    init = dictionary(init);
    const headers = new runtime.Headers(init.headers);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    return new ResponseImpl(text, {
      ...init,
      headers,
    });
  }

  static redirect(url: string, status = 302) {
    if (arguments.length === 0) {
      throw new TypeError("Response.redirect requires a URL");
    }
    const location = new runtime.URL(url).href;
    status = unsignedShort(status);
    if (![301, 302, 303, 307, 308].includes(status)) {
      throw new RangeError("Invalid redirect status");
    }
    const response = new ResponseImpl(null, {
      status,
      headers: {
        location,
      },
    });
    response.freezeHeaders();
    return response;
  }
}

Object.defineProperty(ResponseImpl, "name", { value: "Response" });

runtime.Response ??= ResponseImpl;
