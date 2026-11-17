# @fetchlet/sveltekit-adapter

SvelteKitのserverをfetchlet用IIFEへbundleし、client assetsと形式情報を出力します。SvelteKit 3.2.0 / Svelte 5.57.3で、同期rendering profile（既定）と非同期rendering profileを検証しています。

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

出力は `server.js`、`client/`、`fetchlet.json`。Rust側のFetch entryは `handle` です。contextにclientAddressを渡すとSvelteKitのgetClientAddressへ接続します。固定bindingはplatform.envへ、応答後の処理を登録する `waitUntil` はplatform.context.waitUntilへ、文字列bindingはserver.initのenvへ渡します。

## rendering profile

| `rendering`             | 用途                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `"synchronous"`（既定） | Svelteの同期rendering。`node:async_hooks` を使わない                                                                |
| `"async"`               | Svelteの非同期rendering（`compilerOptions.experimental.async`）とremote functions（`experimental.remoteFunctions`） |

`"async"` は共通builderの `asyncContext: "serialized"` を使い、`getRequestEvent()` と描画中のremote form / queryが `await` をまたいで現在のRequestを参照できるようにします。Appはinvocationを直列に実行するため、storeはそのRequestのものです。1つのRequestの描画中に並行するremote functionの間は、最後に開始した呼び出しのstoreが見えます。remote functionの本体では、`getRequestEvent()` を最初の `await` より前で呼びます。

```ts
sveltekit({
  compilerOptions: { experimental: { async: true } },
  experimental: { remoteFunctions: true },
  adapter: fetchletAdapter({ rendering: "async" }),
});
```

Rustサーバとの接続例とE2Eは、同期profileが `examples/sveltekit-axum`、非同期profileが `examples/sveltekit-axum-tauri` です。次の拡張対象はserver側asset readとstreamingです。remote functionの `query.live` はstreaming応答を使うため、streamingに合わせて対応します。
