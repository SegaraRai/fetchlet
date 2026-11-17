import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { buildArtifact } from "../build/index.mjs";

function synchronousRendering() {
  const virtualId = "\0fetchlet:async-hooks";
  return {
    name: "fetchlet-synchronous-rendering",
    enforce: "pre",
    resolveId(id) {
      if (id === "node:async_hooks") {
        return virtualId;
      }
    },
    load(id) {
      if (id === virtualId) {
        return `export class AsyncLocalStorage {
          constructor() {
            throw new Error("This fetchlet profile uses synchronous Svelte rendering");
          }
        }`;
      }
    },
  };
}

/**
 * @param {object} [options]
 * @param {string} [options.out]
 * @param {"portable" | "quickjs" | "boa" | "v8"} [options.backend]
 * @param {object} [options.intl]
 * @param {"synchronous" | "async"} [options.rendering] "async" supports Svelte's
 *   asynchronous server rendering and remote functions: `getRequestEvent()`
 *   keeps the current request across awaits within one invocation.
 * @returns {import("@sveltejs/kit").Adapter}
 */
export default function fetchletAdapter({
  out = "build",
  backend = "portable",
  intl = {},
  rendering = "synchronous",
} = {}) {
  if (rendering !== "synchronous" && rendering !== "async") {
    throw new Error(`Unknown rendering profile ${JSON.stringify(rendering)}`);
  }
  return {
    name: "fetchlet/sveltekit",
    async adapt(builder) {
      const output = resolve(out);
      const temporary = resolve(builder.getBuildDirectory("fetchlet"));
      const server = join(temporary, "server");
      const entry = join(temporary, "entry.ts");
      mkdirSync(output, { recursive: true });
      mkdirSync(temporary, { recursive: true });

      builder.writeServer(server);
      builder.generateServerInstance(join(temporary, "server-instance.js"), {
        serverDirectory: server,
      });
      builder.writeClient(join(output, "client"));
      builder.writePrerendered(join(output, "client"));

      writeFileSync(
        entry,
        `
        import { createFetchHandler, getBindings, waitUntil } from "fetchlet/runtime/adapter";
        import { server } from "./server-instance.js";

        const bindings = getBindings();
        const env = Object.fromEntries(
          Object.entries(bindings).filter(([, value]) => typeof value === "string"),
        );
        let initialization;

        export const handle = createFetchHandler(async (request, context) => {
          initialization ??= server.init({ env });
          await initialization;
          return server.respond(request, {
            getClientAddress: () => context.clientAddress,
            platform: {
              env: bindings,
              context: {
                waitUntil,
              },
            },
          });
        });
      `,
      );

      await buildArtifact({
        entry,
        outDir: output,
        // An App runs one invocation at a time, so a store that lasts until
        // the request's promise settles is the request's own.
        ...(rendering === "async"
          ? { asyncContext: "serialized" }
          : { plugins: [synchronousRendering()] }),
        framework: "sveltekit",
        rendering,
        backend,
        intl,
      });
    },
  };
}
