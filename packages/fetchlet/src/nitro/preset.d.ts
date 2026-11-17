import type { NitroPreset, NitroPresetMeta } from "nitropack/types";

/** The Nitro preset; apps select it with `preset: "fetchlet/nitro"`. */
declare const preset: NitroPreset & { _meta: NitroPresetMeta };

export default preset;
