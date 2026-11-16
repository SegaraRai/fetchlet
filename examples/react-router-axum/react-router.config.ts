import type { Config } from "@react-router/dev/config";
import { fetchletPreset } from "@fetchlet/react-router-preset";

export default {
  appDirectory: "app",
  buildDirectory: "build",
  presets: [
    fetchletPreset({
      backend: "quickjs",
    }),
  ],
} satisfies Config;
