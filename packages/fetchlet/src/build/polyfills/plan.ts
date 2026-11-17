import { createRequire } from "node:module";

import { backendCapabilities, intlPolyfills, type IntlPolyfill } from "./catalog.ts";

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
  /** Requirements the backend provides natively, checked when the artifact starts. */
  nativeRequirements: string[];
  polyfills: { api: string; package: string; modules: string[] }[];
  intl: { locales: string[]; timeZoneData: TimeZoneData };
  /** Resolved module files, in dependency order. */
  imports: string[];
}

const require = createRequire(import.meta.url);

function polyfillFor(api: string): IntlPolyfill {
  const polyfill = Object.hasOwn(intlPolyfills, api) ? intlPolyfills[api] : undefined;
  if (!polyfill) {
    throw new Error("Unsupported fetchlet Intl API: " + api);
  }
  return polyfill;
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
      require.resolve(specifier);
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

/** Resolve only missing Intl APIs, in dependency order, before bundling. */
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
  function include(api: string): void {
    if (!api.startsWith("Intl.")) {
      return;
    }
    const polyfill = polyfillFor(api);
    if (native.has(api)) {
      nativeRequirements.add(api);
      return;
    }
    if (selected.has(api)) {
      return;
    }
    for (const dependency of polyfill.dependencies) {
      include(dependency);
    }
    selected.add(api);
  }
  for (const api of requested) {
    include(api);
  }
  const polyfills: PolyfillPlan["polyfills"] = [];
  const imports: string[] = [];
  for (const api of selected) {
    const implementation = polyfillFor(api);
    const modules = [implementation.package + "/polyfill.js"];
    if (implementation.localeData) {
      modules.push(
        ...new Set(canonicalLocales.map((locale) => localeModule(implementation.package, locale))),
      );
    }
    if (api === "Intl.DateTimeFormat" && timeZoneData !== "utc") {
      modules.push(implementation.package + "/add-" + timeZoneData + "-tz.js");
    }
    imports.push(...modules.map((specifier) => require.resolve(specifier)));
    polyfills.push({ api, package: implementation.package, modules });
  }
  return {
    backend,
    requirements: requested,
    nativeRequirements: [...nativeRequirements],
    polyfills,
    intl: { locales: canonicalLocales, timeZoneData },
    imports,
  };
}
