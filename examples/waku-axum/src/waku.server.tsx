import adapter from "fetchlet/waku";
import { fsRouter } from "waku";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("/src/pages/**/*.{tsx,ts}")).map(([key, load]) => [
    key.slice("/src/".length),
    load,
  ]),
);

export default adapter(fsRouter(modules), {
  backend:
    // The entry also runs inside the artifact, where process is absent.
    (globalThis.process?.env.FETCHLET_BACKEND ?? "quickjs") as "quickjs" | "boa" | "v8",
});
