import type { PolyfillPlan } from "./plan.ts";

/** Check native assumptions before evaluating the application's modules. */
export function nativeCapabilityCheck(plan: PolyfillPlan): string {
  return `
    const requirements = ${JSON.stringify(plan.nativeRequirements)};
    const locales = ${JSON.stringify(plan.intl.locales)};
    for (const api of requirements) {
      const name = api.slice("Intl.".length);
      const implementation = globalThis.Intl?.[name];
      if (typeof implementation !== "function") {
        throw new Error("fetchlet artifact requires native " + api + "; rebuild for this backend");
      }
      if (typeof implementation.supportedLocalesOf === "function") {
        const supported = implementation.supportedLocalesOf(locales);
        if (supported.length !== locales.length) {
          throw new Error("fetchlet artifact requires " + api + " locales: " + locales.join(", "));
        }
      }
    }
    `;
}
