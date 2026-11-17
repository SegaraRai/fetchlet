import type { BuildBackend } from "./plan.ts";

export interface IntlPolyfill {
  package: string;
  dependencies: string[];
  localeData: boolean;
}

/** Capabilities measured in fetchlet's default engine configurations. */
export const backendCapabilities: Record<BuildBackend, string[]> = {
  portable: [],
  quickjs: [],
  boa: [],
  v8: [
    "Intl.getCanonicalLocales",
    "Intl.Locale",
    "Intl.PluralRules",
    "Intl.NumberFormat",
    "Intl.DateTimeFormat",
  ],
};

/** Dependencies follow the pinned FormatJS releases' runtime requirements. */
export const intlPolyfills: Record<string, IntlPolyfill> = {
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
  },
};
