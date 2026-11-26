import nimbus, { defineConfig as defineNimbusConfig } from "@cloudflare/nimbus-docs";
import { siteHtml } from "@fetchlet-internal/tools-site-html/astro";
import { stillwind } from "@stillwind/integration/astro";
import { defineConfig } from "astro/config";

import { mermaidPlugin } from "./src/lib/docs/mermaid";
import { packageManagerPlugin } from "./src/lib/docs/package-managers";

export default defineConfig({
  trailingSlash: "never",
  compressHTML: "jsx",
  integrations: [
    nimbus(
      defineNimbusConfig({
        site: process.env.PUBLIC_WEBSITE_URL ?? "https://fetchlet.roundtrip.dev",
        title: "fetchlet",
        description:
          "Run the server side of JavaScript web frameworks inside a Rust application, on QuickJS, Boa or V8.",
        locale: "en",
        github: "https://github.com/SegaraRai/fetchlet",
        editPattern: "https://github.com/SegaraRai/fetchlet/edit/main/apps/website/{path}",
        socialImage: "/og.png",
        sidebar: {
          items: [
            "docs", // Getting started
            {
              label: "Overview",
              items: ["docs/overview", "docs/agents"],
            },
            {
              label: "Frameworks",
              items: [
                "docs/frameworks",
                "docs/frameworks/astro",
                "docs/frameworks/hono",
                "docs/frameworks/nitro",
                "docs/frameworks/qwik-city",
                "docs/frameworks/react-router",
                "docs/frameworks/solid",
                "docs/frameworks/solid-start",
                "docs/frameworks/sveltekit",
                "docs/frameworks/tanstack-start",
                "docs/frameworks/vinext",
                "docs/frameworks/waku",
                "docs/frameworks/vite",
              ],
            },
            {
              label: "Development & building",
              items: ["docs/javascript/dev", "docs/javascript/build", "docs/javascript/runtime"],
            },
            {
              label: "Rust host",
              items: [
                "docs/rust/fetchlet-http",
                "docs/rust/fetchlet",
                "docs/rust/host-services",
                "docs/rust/in-process-fetch",
                "docs/rust/fetchlet-net",
                "docs/rust/resource-policy",
              ],
            },
            {
              label: "Shipping & security",
              items: ["docs/shipping/embedding", "docs/shipping/security"],
            },
            {
              label: "Compatibility",
              items: ["docs/compatibility/web-api", "docs/compatibility/node"],
            },
            {
              label: "Architecture & reference",
              items: [
                "docs/concepts/domain-model",
                "docs/concepts/data-flow",
                "docs/reference/asset-archive",
                "docs/rust/fetchlet-web",
              ],
            },
          ],
        },
      }),
      {
        markdown: {
          mdastPlugins: [mermaidPlugin, packageManagerPlugin],
        },
        rules: {
          "nimbus/frontmatter-shape": "error",
          "nimbus/internal-link": "error",
        },
      },
    ),
    stillwind(),
    siteHtml({
      cloudflareWebAnalytics: true,
      contentSecurityPolicy: {
        "default-src": ["'self'"],
        // Pagefind compiles WASM.
        "script-src": ["'self'", "'wasm-unsafe-eval'"],
        "style-src": ["'self'"],
        // Pages set custom properties in style attributes.
        "style-src-attr": ["'unsafe-inline'"],
        // Icon utilities embed SVG images as data URLs.
        "img-src": ["'self'", "data:"],
        "object-src": ["'none'"],
        "base-uri": ["'none'"],
        "form-action": ["'self'"],
        "frame-ancestors": ["'none'"],
      },
    }),
  ],
  server: {
    port: 4323,
  },
  build: {
    inlineStylesheets: "never",
  },
});
