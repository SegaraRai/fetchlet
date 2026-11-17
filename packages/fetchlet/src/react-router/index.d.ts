import type { Preset } from "@react-router/dev/config";

export interface FetchletPresetOptions {
  /** The engine the artifact targets. */
  backend?: "portable" | "quickjs" | "boa" | "v8";
  /** Intl data for engines without native Intl, as in fetchlet/build. */
  intl?: {
    locales?: string[];
    timeZoneData?: "utc" | "golden" | "all";
    apis?: string[];
  };
}

/** Bundle the React Router server build into a fetchlet artifact. */
export function fetchletPreset(options?: FetchletPresetOptions): Preset;
