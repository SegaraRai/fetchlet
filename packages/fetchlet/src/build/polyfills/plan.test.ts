import { engineOnlyApis, polyfills } from "@fetchlet/web/gaps";
import { describe, expect, test } from "vite-plus/test";

import { backendCapabilities } from "./engine-capabilities.ts";
import { planPolyfills, type PlanOptions } from "./plan.ts";

// Options from JavaScript callers, which the declared types would reject.
const plan = (options: unknown) => () => planPolyfills(options as PlanOptions);

describe("planPolyfills", () => {
  test("defaults to the portable backend, English and UTC with nothing selected", () => {
    expect(planPolyfills()).toStrictEqual({
      backend: "portable",
      requirements: [],
      nativeRequirements: [],
      hostApis: [],
      polyfills: [],
      intl: {
        locales: ["en"],
        timeZoneData: "utc",
      },
      imports: [],
    });
  });

  test("selects dependencies before the API that needs them", () => {
    const { polyfills } = planPolyfills({
      requirements: ["Intl.DateTimeFormat"],
    });
    expect(polyfills.map((polyfill) => polyfill.api)).toStrictEqual([
      "Intl.getCanonicalLocales",
      "Intl.Locale",
      "Intl.PluralRules",
      "Intl.NumberFormat",
      "Intl.DateTimeFormat",
    ]);
  });

  test("each API is selected once, and requirements and intl.apis merge", () => {
    const result = planPolyfills({
      requirements: ["Intl.PluralRules", "Intl.Locale", "Intl.PluralRules"],
      intl: {
        apis: ["Intl.Locale"],
      },
    });
    expect(result.requirements).toStrictEqual(["Intl.PluralRules", "Intl.Locale"]);
    expect(result.polyfills.map((polyfill) => polyfill.api)).toStrictEqual([
      "Intl.getCanonicalLocales",
      "Intl.Locale",
      "Intl.PluralRules",
    ]);
  });

  test("globals over host APIs become host requirements without polyfills", () => {
    const result = planPolyfills({
      requirements: ["crypto.subtle", "CompressionStream", "crypto", "Intl.Locale"],
    });
    expect(result.requirements).toStrictEqual([
      "crypto.subtle",
      "CompressionStream",
      "crypto",
      "Intl.Locale",
    ]);
    expect(result.hostApis).toStrictEqual(["compression", "crypto"]);
    expect(result.polyfills.map((polyfill) => polyfill.api)).toStrictEqual([
      "Intl.getCanonicalLocales",
      "Intl.Locale",
    ]);
  });

  test("an unknown requirement fails instead of passing unchecked", () => {
    expect(() => planPolyfills({ requirements: ["fetch"] })).toThrow(
      /Unknown fetchlet requirement: fetch; expected an Intl API, an engine API \(WebAssembly, .*\) or a global over a host Web API \(crypto, /,
    );
  });

  test("APIs the backend provides become native requirements instead", () => {
    const result = planPolyfills({
      backend: "v8",
      requirements: ["Intl.DateTimeFormat"],
      intl: {
        locales: ["ja"],
        timeZoneData: "all",
      },
    });
    expect(result.polyfills).toStrictEqual([]);
    expect(result.imports).toStrictEqual([]);
    expect(result.nativeRequirements).toStrictEqual(["Intl.DateTimeFormat"]);
  });

  test("every backend's native capabilities are APIs the catalog knows", () => {
    for (const apis of Object.values(backendCapabilities)) {
      for (const api of apis) {
        expect(Object.hasOwn(polyfills, api) || engineOnlyApis.includes(api), api).toBe(true);
      }
    }
  });

  test("every polyfill's dependencies are polyfillable, so any backend can satisfy them", () => {
    for (const [api, polyfill] of Object.entries(polyfills)) {
      expect(engineOnlyApis.includes(api), api).toBe(false);
      for (const dependency of polyfill.dependencies) {
        expect(Object.hasOwn(polyfills, dependency), api + " -> " + dependency).toBe(true);
      }
    }
  });

  test.each([
    ["Intl.ListFormat", ["Intl.getCanonicalLocales", "Intl.Locale", "Intl.ListFormat"]],
    ["Intl.DisplayNames", ["Intl.getCanonicalLocales", "Intl.Locale", "Intl.DisplayNames"]],
    [
      "Intl.RelativeTimeFormat",
      [
        "Intl.getCanonicalLocales",
        "Intl.Locale",
        "Intl.PluralRules",
        "Intl.NumberFormat",
        "Intl.RelativeTimeFormat",
      ],
    ],
    ["Intl.Segmenter", ["Intl.getCanonicalLocales", "Intl.Segmenter"]],
    [
      "Intl.DurationFormat",
      [
        "Intl.getCanonicalLocales",
        "Intl.Locale",
        "Intl.ListFormat",
        "Intl.PluralRules",
        "Intl.NumberFormat",
        "Intl.DurationFormat",
      ],
    ],
  ])("%s selects its dependencies first", (api, expected) => {
    const { polyfills: selected } = planPolyfills({
      requirements: [api],
      intl: { locales: ["ja"] },
    });
    expect(selected.map((polyfill) => polyfill.api)).toStrictEqual(expected);
  });

  test("engine-only APIs are left to the engine, or fail on a backend that lacks them", () => {
    expect(
      planPolyfills({ requirements: ["WebAssembly", "Intl.Collator"] }).nativeRequirements,
    ).toStrictEqual(["WebAssembly", "Intl.Collator"]);
    expect(planPolyfills({ backend: "v8", requirements: ["WebAssembly"] })).toMatchObject({
      nativeRequirements: ["WebAssembly"],
      polyfills: [],
    });
    expect(plan({ backend: "quickjs", requirements: ["WebAssembly"] })).toThrow(
      "WebAssembly is not available on the quickjs backend and has no polyfill",
    );
    expect(plan({ backend: "boa", requirements: ["Intl.supportedValuesOf"] })).toThrow(
      /not available on the boa backend/,
    );
  });

  test("locales are canonicalized and resolve through their parents", () => {
    const result = planPolyfills({
      requirements: ["Intl.PluralRules"],
      intl: {
        locales: ["EN-us", "ja-JP", "en"],
      },
    });
    expect(result.intl.locales).toStrictEqual(["en-US", "ja-JP", "en"]);
    const plural = result.polyfills.find((polyfill) => polyfill.api === "Intl.PluralRules");
    // en-US shares en's data, and FormatJS has no separate ja-JP file.
    expect(plural?.modules).toStrictEqual([
      "@formatjs/intl-pluralrules/polyfill.js",
      "@formatjs/intl-pluralrules/locale-data/en.js",
      "@formatjs/intl-pluralrules/locale-data/ja.js",
    ]);
  });

  test("APIs without locale data import only their polyfill", () => {
    const { polyfills } = planPolyfills({
      requirements: ["Intl.Locale"],
      intl: {
        locales: ["fr", "de"],
      },
    });
    for (const polyfill of polyfills) {
      expect(polyfill.modules).toStrictEqual([polyfill.package + "/polyfill.js"]);
    }
  });

  test.each(["golden", "all"] as const)(
    "timeZoneData %s adds its zone data to DateTimeFormat only",
    (data) => {
      const { polyfills } = planPolyfills({
        requirements: ["Intl.DateTimeFormat"],
        intl: {
          timeZoneData: data,
        },
      });
      const dateTime = polyfills.find((polyfill) => polyfill.api === "Intl.DateTimeFormat");
      expect(dateTime?.modules.at(-1)).toBe(`@formatjs/intl-datetimeformat/add-${data}-tz.js`);
      const others = polyfills.filter((polyfill) => polyfill.api !== "Intl.DateTimeFormat");
      expect(others.flatMap((polyfill) => polyfill.modules).some((m) => m.includes("-tz.js"))).toBe(
        false,
      );
    },
  );

  test("imports are the resolved files of every module, in order", () => {
    const result = planPolyfills({
      requirements: ["Intl.NumberFormat"],
      intl: {
        locales: ["ja"],
      },
    });
    const modules = result.polyfills.flatMap((polyfill) => polyfill.modules);
    expect(result.imports).toHaveLength(modules.length);
    result.imports.forEach((file, index) => {
      const specifier = modules[index]!;
      const name = specifier.slice(specifier.lastIndexOf("/") + 1);
      expect(file.replaceAll("\\", "/").endsWith("/" + name), file).toBe(true);
    });
  });

  test("invalid options fail with the option's name", () => {
    expect(plan({ requirements: "Intl.Locale" })).toThrow(/requirements must be an array/);
    expect(plan({ requirements: [""] })).toThrow(/requirements must be an array/);
    expect(plan({ requirements: [1] })).toThrow(/requirements must be an array/);
    expect(plan({ intl: { apis: "Intl.Locale" } })).toThrow(/intl\.apis must be an array/);
    expect(plan({ backend: "unknown" })).toThrow("Unknown fetchlet backend: unknown");
    expect(plan({ backend: "toString" })).toThrow(/Unknown fetchlet backend/);
    expect(plan({ requirements: ["Intl.Unknown"] })).toThrow(
      "Unsupported fetchlet Intl API: Intl.Unknown",
    );
    expect(plan({ requirements: ["Intl.hasOwnProperty"] })).toThrow(/Unsupported/);
    expect(plan({ intl: { locales: [] } })).toThrow(/at least one locale/);
    expect(plan({ intl: { locales: "en" } })).toThrow(/at least one locale/);
    expect(plan({ intl: { locales: ["not a locale"] } })).toThrow(RangeError);
    expect(plan({ intl: { timeZoneData: "none" } })).toThrow(/utc, golden or all/);
  });

  test("unknown APIs fail on every backend, including one with native Intl", () => {
    expect(plan({ backend: "v8", requirements: ["Intl.Unknown"] })).toThrow(/Unsupported/);
  });

  test("a locale without data fails only when an API needs locale data", () => {
    expect(plan({ requirements: ["Intl.Locale"], intl: { locales: ["zz"] } })).not.toThrow();
    expect(plan({ requirements: ["Intl.PluralRules"], intl: { locales: ["zz"] } })).toThrow(
      "FormatJS locale data is unavailable: @formatjs/intl-pluralrules / zz",
    );
  });
});
