import { hostApiRequirements } from "@fetchlet/web/capabilities";
import {
  engineOnlyApis,
  polyfills,
  resolvePolyfillModule,
  type Polyfill,
} from "@fetchlet/web/gaps";

import { backendCapabilities } from "./engine-capabilities.ts";

export type BuildBackend = "quickjs" | "boa" | "v8" | "portable";

export type TimeZoneData = "utc" | "golden" | "all";

export interface IntlOptions {
  /** BCP 47 locales whose FormatJS data is bundled. Default `["en"]`. */
  locales?: string[];
  /** IANA time zone data for DateTimeFormat. Default `"utc"`. */
  timeZoneData?: TimeZoneData;
  /** Additional Intl APIs the application requires, such as `"Intl.NumberFormat"`. */
  apis?: string[];
}

export interface PlanOptions {
  backend?: BuildBackend;
  requirements?: string[];
  intl?: IntlOptions;
}

export interface PolyfillPlan {
  backend: BuildBackend;
  requirements: string[];
  /**
   * Requirements left to the engine, checked when the artifact starts: APIs
   * the backend provides natively, and on `portable`, engine-only APIs.
   */
  nativeRequirements: string[];
  /** fetchlet-web APIs the requirements need from the host, sorted. */
  hostApis: string[];
  polyfills: {
    api: string;
    package: string;
    modules: string[];
  }[];
  intl: {
    locales: string[];
    timeZoneData: TimeZoneData;
  };
  /** Resolved module files, in dependency order. */
  imports: string[];
}

function polyfillFor(api: string): Polyfill | undefined {
  return Object.hasOwn(polyfills, api) ? polyfills[api] : undefined;
}

function validateApiList(name: string, value: unknown): void {
  if (!Array.isArray(value) || value.some((api) => typeof api !== "string" || api.length === 0)) {
    throw new TypeError(name + " must be an array of API names");
  }
}

function localeModule(packageName: string, locale: string): string {
  // FormatJS omits redundant regional files; resolve through the locale's parents.
  let candidate = new Intl.Locale(locale).baseName;
  while (candidate) {
    const specifier = packageName + "/locale-data/" + candidate + ".js";
    try {
      resolvePolyfillModule(specifier);
      return specifier;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") {
        throw error;
      }
    }
    const separator = candidate.lastIndexOf("-");
    candidate = separator < 0 ? "" : candidate.slice(0, separator);
  }
  throw new Error("FormatJS locale data is unavailable: " + packageName + " / " + locale);
}

/**
 * Sort each requirement: an API the backend provides natively, an API to
 * polyfill (with its dependencies, in dependency order), an engine-only API
 * (left to the host's check on `portable`, a build error on a backend that
 * lacks it), or a global that the Web API profile installs only over a host
 * API. Any other name fails, so a requirement never passes unchecked.
 */
export function planPolyfills({
  backend = "portable",
  requirements = [],
  intl = {},
}: PlanOptions = {}): PolyfillPlan {
  if (!Object.hasOwn(backendCapabilities, backend)) {
    throw new Error("Unknown fetchlet backend: " + backend);
  }
  const { locales = ["en"], timeZoneData = "utc", apis = [] } = intl;
  validateApiList("requirements", requirements);
  validateApiList("intl.apis", apis);
  if (!Array.isArray(locales) || locales.length === 0) {
    throw new Error("intl.locales must contain at least one locale");
  }
  const canonicalLocales = Intl.getCanonicalLocales(locales);
  if (!["utc", "golden", "all"].includes(timeZoneData)) {
    throw new Error("intl.timeZoneData must be utc, golden or all");
  }
  const requested = [...new Set([...requirements, ...apis])];
  const native = new Set(backendCapabilities[backend]);
  const selected = new Set<string>();
  const nativeRequirements = new Set<string>();
  const hostApis = new Set<string>();
  // Returns false for a name that is neither an engine API nor polyfillable.
  function include(api: string): boolean {
    if (native.has(api)) {
      nativeRequirements.add(api);
      return true;
    }
    if (engineOnlyApis.includes(api)) {
      if (backend !== "portable") {
        throw new Error(
          api +
            " is not available on the " +
            backend +
            " backend and has no polyfill; build for a backend that provides it",
        );
      }
      nativeRequirements.add(api);
      return true;
    }
    const polyfill = polyfillFor(api);
    if (!polyfill) {
      return false;
    }
    if (!selected.has(api)) {
      for (const dependency of polyfill.dependencies) {
        include(dependency);
      }
      selected.add(api);
    }
    return true;
  }
  for (const api of requested) {
    if (include(api)) {
      continue;
    }
    if (api.startsWith("Intl.")) {
      throw new Error("Unsupported fetchlet Intl API: " + api);
    }
    const needs = Object.hasOwn(hostApiRequirements, api) ? hostApiRequirements[api] : undefined;
    if (!needs) {
      throw new Error(
        "Unknown fetchlet requirement: " +
          api +
          "; expected an Intl API, an engine API (" +
          engineOnlyApis.filter((name) => !name.startsWith("Intl.")).join(", ") +
          ") or a global over a host Web API (" +
          Object.keys(hostApiRequirements).join(", ") +
          ")",
      );
    }
    for (const hostApi of needs) {
      hostApis.add(hostApi);
    }
  }
  const selectedPolyfills: PolyfillPlan["polyfills"] = [];
  const imports: string[] = [];
  for (const api of selected) {
    const implementation = polyfillFor(api)!;
    const modules = [implementation.package + "/polyfill.js"];
    if (implementation.localeData) {
      modules.push(
        ...new Set(canonicalLocales.map((locale) => localeModule(implementation.package, locale))),
      );
    }
    if (implementation.timeZoneData && timeZoneData !== "utc") {
      modules.push(implementation.package + "/add-" + timeZoneData + "-tz.js");
    }
    imports.push(...modules.map(resolvePolyfillModule));
    selectedPolyfills.push({ api, package: implementation.package, modules });
  }
  return {
    backend,
    requirements: requested,
    nativeRequirements: [...nativeRequirements],
    hostApis: [...hostApis].sort(),
    polyfills: selectedPolyfills,
    intl: {
      locales: canonicalLocales,
      timeZoneData,
    },
    imports,
  };
}
