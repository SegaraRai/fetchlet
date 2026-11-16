# @fetchlet/sveltekit-adapter

SvelteKitのserverをfetchlet用IIFEへbundleし、client assetsと形式情報を出力します。現在はSvelteKit 3.2.0 / Svelte 5.57.3の同期rendering profileを検証しています。

```ts
import { defineConfig } from "vite-plus";
import { sveltekit } from "@sveltejs/kit/vite";
import fetchletAdapter from "@fetchlet/sveltekit-adapter";

export default defineConfig({
  plugins: [
    sveltekit({
      compilerOptions: { experimental: { async: false } },
      adapter: fetchletAdapter({ out: "build" }),
    }),
  ],
});
```

出力は `server.js`、`client/`、`fetchlet.json`。Rust側のFetch entryは `handle` です。contextにclientAddressを渡すとSvelteKitのgetClientAddressへ接続します。固定bindingはplatform.envへ、文字列bindingはserver.initのenvへ渡します。

Rustサーバとの接続例とE2Eは `examples/sveltekit-axum` を参照してください。次の拡張対象はserver側asset read、streaming、追加のrendering profileです。
