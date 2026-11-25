import type { Config } from "@react-router/dev/config";
import { fetchletPreset } from "fetchlet/react-router";

export default {
  appDirectory: "app",
  buildDirectory: "build",
  // Served from the asset archive; the other pages render per request.
  prerender: ["/about"],
  presets: [
    fetchletPreset({
      backend: (process.env.FETCHLET_BACKEND ?? "quickjs") as "quickjs" | "boa" | "v8",
      assets: true,
    }),
  ],
} satisfies Config;
