import { createRequire } from "node:module";

import { backendCapabilities, intlPolyfills } from "./catalog.js";

const require = createRequire(import.meta.url);

function validateApiList(name, value) {
  if (!Array.isArray(value) || value.some((api) => typeof api !== "string" || api.length === 0)) {
    throw new TypeError(name + " must be an array of API names");
  }
}

function localeModule(packageName, locale) {
  // FormatJS omits redundant regional files; resolve through the locale's parents.
  let candidate = new Intl.Locale(locale).baseName;
  while (candidate) {
    const specifier = packageName + "/locale-data/" + candidate + ".js";
    try {
      require.resolve(specifier);
      return specifier;
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND") {
        throw error;
      }
    }
    const separator = candidate.lastIndexOf("-");
    candidate = separator < 0 ? "" : candidate.slice(0, separator);
  }
  throw new Error("FormatJS locale data is unavailable: " + packageName + " / " + locale);
}

/** Resolve only missing Intl APIs, in dependency order, before bundling. */
export function planPolyfills({ backend = "portable", requirements = [], intl = {} } = {}) {
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
  const selected = new Set();
  const nativeRequirements = new Set();
  function include(api) {
    if (!api.startsWith("Intl.")) {
      return;
    }
    if (!Object.hasOwn(intlPolyfills, api)) {
      throw new Error("Unsupported fetchlet Intl API: " + api);
    }
    if (native.has(api)) {
      nativeRequirements.add(api);
      return;
    }
    if (selected.has(api)) {
      return;
    }
    for (const dependency of intlPolyfills[api].dependencies) {
      include(dependency);
    }
    selected.add(api);
  }
  for (const api of requested) {
    include(api);
  }
  const polyfills = [];
  const imports = [];
  for (const api of selected) {
    const implementation = intlPolyfills[api];
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
