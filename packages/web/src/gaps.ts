// What the profile fills where an engine lacks it, for fetchlet/build to plan
// a bundle from. Like ./capabilities, build tools import it in Node; it runs
// in no engine.

import { createRequire } from "node:module";

/** A polyfill that installs an API only where the engine lacks it. */
export interface Polyfill {
  /** The package whose `polyfill.js` installs the API. */
  package: string;
  /** APIs the polyfill needs at run time, natively or polyfilled first. */
  dependencies: string[];
  /** Whether the package has `locale-data/<locale>.js` files to import. */
  localeData: boolean;
  /** Whether `intl.timeZoneData` adds the package's `add-<data>-tz.js`. */
  timeZoneData?: boolean;
}

/**
 * APIs that only an engine provides, because no polyfill implements them at
 * a usable speed or with the engine's semantics. A build for a backend that
 * lacks one fails; a `portable` build leaves it to the host's check.
 */
export const engineOnlyApis: readonly string[] = [
  // FormatJS has no Collator, and supportedValuesOf enumerates collations
  // through the installed Collator.
  "Intl.Collator",
  "Intl.supportedValuesOf",
  "WebAssembly",
  "SharedArrayBuffer",
  "Atomics",
];

/**
 * Polyfills by API. Dependencies follow the pinned FormatJS releases'
 * documented requirements and what each polyfill calls.
 */
export const polyfills: Readonly<Record<string, Polyfill>> = {
  "Intl.getCanonicalLocales": {
    package: "@formatjs/intl-getcanonicallocales",
    dependencies: [],
    localeData: false,
  },
  "Intl.Locale": {
    package: "@formatjs/intl-locale",
    dependencies: ["Intl.getCanonicalLocales"],
    localeData: false,
  },
  "Intl.PluralRules": {
    package: "@formatjs/intl-pluralrules",
    dependencies: ["Intl.getCanonicalLocales", "Intl.Locale"],
    localeData: true,
  },
  "Intl.NumberFormat": {
    package: "@formatjs/intl-numberformat",
    dependencies: ["Intl.getCanonicalLocales", "Intl.Locale", "Intl.PluralRules"],
    localeData: true,
  },
  "Intl.DateTimeFormat": {
    package: "@formatjs/intl-datetimeformat",
    dependencies: ["Intl.getCanonicalLocales", "Intl.Locale", "Intl.NumberFormat"],
    localeData: true,
    timeZoneData: true,
  },
  "Intl.ListFormat": {
    package: "@formatjs/intl-listformat",
    dependencies: ["Intl.getCanonicalLocales", "Intl.Locale"],
    localeData: true,
  },
  "Intl.DisplayNames": {
    package: "@formatjs/intl-displaynames",
    dependencies: ["Intl.getCanonicalLocales", "Intl.Locale"],
    localeData: true,
  },
  "Intl.RelativeTimeFormat": {
    package: "@formatjs/intl-relativetimeformat",
    dependencies: [
      "Intl.getCanonicalLocales",
      "Intl.Locale",
      "Intl.PluralRules",
      "Intl.NumberFormat",
    ],
    localeData: true,
  },
  // Segmentation rules are built in; locales without CLDR tailoring use the
  // root rules.
  "Intl.Segmenter": {
    package: "@formatjs/intl-segmenter",
    dependencies: ["Intl.getCanonicalLocales"],
    localeData: false,
  },
  // Formats through ListFormat and NumberFormat, whose locale data it uses.
  "Intl.DurationFormat": {
    package: "@formatjs/intl-durationformat",
    dependencies: [
      "Intl.getCanonicalLocales",
      "Intl.Locale",
      "Intl.ListFormat",
      "Intl.NumberFormat",
    ],
    localeData: false,
  },
};

const require = createRequire(import.meta.url);

/**
 * The file of a module in a polyfill package, such as
 * `@formatjs/intl-locale/polyfill.js`. The packages are dependencies of this
 * one, so they resolve from here. Throws `MODULE_NOT_FOUND` for a missing
 * module.
 */
export function resolvePolyfillModule(specifier: string): string {
  return require.resolve(specifier);
}
