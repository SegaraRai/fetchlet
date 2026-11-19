// URLPattern (https://urlpattern.spec.whatwg.org/). The host parses patterns
// and canonicalizes inputs with the urlpattern crate; the component regular
// expressions run in this engine's RegExp.

import { hostFunctions } from "../runtime/host";
import { runtime } from "../runtime/runtime";
import { hostProvides } from "../runtime/web-host";
import { dictionary, exposeAttributes, usvString } from "../webidl/idl";

if (!runtime.URLPattern && hostProvides("url-pattern")) {
  const components = [
    "protocol",
    "username",
    "password",
    "hostname",
    "port",
    "pathname",
    "search",
    "hash",
  ] as const;
  // Web IDL reads dictionary members in lexicographic order.
  const initMembers = ["baseURL", ...[...components].sort()];

  // The standard compiles components with the v flag. QuickJS rejects some
  // escapes in v mode that the standard's patterns use, and Boa has no v
  // flag, so a component that v mode rejects is compiled with u, which
  // differs only in class set notation.
  const compile = (source: string, ignoreCase: boolean) => {
    const caseFlag = ignoreCase ? "i" : "";
    try {
      return new RegExp(source, "v" + caseFlag);
    } catch {
      return new RegExp(source, "u" + caseFlag);
    }
  };

  type Component = {
    patternString: string;
    regexp: RegExp;
    groupNameList: string[];
  };

  const host = (operation: string, input: unknown) => {
    const reply = JSON.parse(hostFunctions()!.call(operation, JSON.stringify(input)));
    if (!reply.ok) {
      const error: any = new Error(reply.error.message);
      error.name = "FetchletHostError";
      error.code = reply.error.code;
      throw error;
    }
    if (reply.value !== null && typeof reply.value.error === "string") {
      throw new TypeError(reply.value.error);
    }
    return reply.value;
  };

  /** URLPatternInput: a string, or a URLPatternInit dictionary. */
  const patternInput = (value: unknown): string | Record<string, string> => {
    if (value === undefined || value === null || typeof value === "object") {
      const source = dictionary(value);
      const init: Record<string, string> = {};
      for (const member of initMembers) {
        const memberValue = source[member];
        if (memberValue !== undefined) {
          init[member] = usvString(memberValue);
        }
      }
      return init;
    }
    return usvString(value);
  };

  /** The overloads (input, baseURL, options) and (input, options). */
  const patternArguments = (args: unknown[]) => {
    const input = patternInput(args[0]);
    const second = args[1];
    if (args.length >= 2 && second !== undefined && second !== null && typeof second !== "object") {
      return {
        input,
        baseURL: usvString(second),
        options: dictionary(args[2]),
      };
    }
    return {
      input,
      baseURL: null,
      options: dictionary(second),
    };
  };

  class URLPatternImpl {
    readonly #components = {} as Record<(typeof components)[number], Component>;
    readonly #hasRegExpGroups = false;

    constructor(...args: unknown[]) {
      const { input, baseURL, options } = patternArguments(args);
      const ignoreCase = Boolean(options.ignoreCase);
      const parsed = host("urlpattern.parse", [input, baseURL, ignoreCase]);
      for (const name of components) {
        const component = parsed[name];
        let regexp: RegExp;
        try {
          regexp = compile(component.regexpString, ignoreCase);
        } catch {
          throw new TypeError(`Invalid ${name} pattern: ${component.patternString}`);
        }
        this.#components[name] = {
          patternString: component.patternString,
          regexp,
          groupNameList: component.groupNameList,
        };
      }
      this.#hasRegExpGroups = parsed.hasRegexpGroups;
    }

    get protocol() {
      return this.#components.protocol.patternString;
    }

    get username() {
      return this.#components.username.patternString;
    }

    get password() {
      return this.#components.password.patternString;
    }

    get hostname() {
      return this.#components.hostname.patternString;
    }

    get port() {
      return this.#components.port.patternString;
    }

    get pathname() {
      return this.#components.pathname.patternString;
    }

    get search() {
      return this.#components.search.patternString;
    }

    get hash() {
      return this.#components.hash.patternString;
    }

    get hasRegExpGroups() {
      return this.#hasRegExpGroups;
    }

    test(input: unknown = {}, baseURL?: unknown) {
      return this.#match(input, baseURL, arguments.length >= 2) !== null;
    }

    exec(input: unknown = {}, baseURL?: unknown) {
      return this.#match(input, baseURL, arguments.length >= 2);
    }

    #match(input: unknown, baseURL: unknown, hasBaseURL: boolean) {
      const converted = patternInput(input);
      const base = hasBaseURL && baseURL !== undefined ? usvString(baseURL) : null;
      const reply = host("urlpattern.match", [converted, base]);
      if (reply === null) {
        return null;
      }
      const [values, inputs] = reply;
      const result: Record<string, unknown> = {
        inputs: inputs.length === 2 && inputs[1] === null ? [inputs[0]] : inputs,
      };
      for (const name of components) {
        const component = this.#components[name];
        const value: string = values[name];
        const match = component.regexp.exec(value);
        if (match === null) {
          return null;
        }
        const groups: Record<string, string | undefined> = {};
        component.groupNameList.forEach((group, index) => {
          groups[group] = match[index + 1];
        });
        result[name] = {
          input: value,
          groups,
        };
      }
      return result;
    }

    get [Symbol.toStringTag]() {
      return "URLPattern";
    }
  }

  exposeAttributes(URLPatternImpl.prototype, [...components, "hasRegExpGroups"]);
  Object.defineProperty(URLPatternImpl, "name", {
    value: "URLPattern",
  });
  runtime.URLPattern = URLPatternImpl;
}
