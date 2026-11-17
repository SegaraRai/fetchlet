export type BuildBackend = "quickjs" | "boa" | "v8" | "portable";

export interface IntlOptions {
  /** BCP 47 locales whose FormatJS data is bundled. Default `["en"]`. */
  locales?: string[];
  /** IANA time zone data for DateTimeFormat. Default `"utc"`. */
  timeZoneData?: "utc" | "golden" | "all";
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
  intl: { locales: string[]; timeZoneData: "utc" | "golden" | "all" };
  /** Resolved module files, in dependency order. */
  imports: string[];
}

/** Resolve only missing Intl APIs, in dependency order, before bundling. */
export function planPolyfills(options?: PlanOptions): PolyfillPlan;
