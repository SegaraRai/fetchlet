# fetchlet/solid-start

SolidStart 2のserver environmentをfetchlet用IIFEへbundleするVite pluginです。@solidjs/start 2.2.3 / solid-js 1.9.19 / @solidjs/router 1.0.3を検証しています。

```ts
// vite.config.ts
import fetchletSolidStart from "fetchlet/solid-start";
import { solidStart } from "@solidjs/start/config";

export default defineConfig({
  plugins: [solidStart(), fetchletSolidStart({ backend: "quickjs" })],
});
```

`backend` / `intl` は[共通builder](build.md)の同名設定です。Nitroは使いません。

## 出力

clientを `build/client/`、serverを `node_modules/.cache/fetchlet-solid-start/` へbuildし、`entry-server` のh3 appを接続した `build/server.js` と `build/fetchlet.json` を書きます。

SSR environmentは依存をすべてbundleします。条件の `solid` はSolidのlibraryをSSR用にsourceからcompileし、`worker` はsolid-jsのserver buildを選びます。h3はruntime非依存のbuildのままです。

`assets: true` はclient assetsを `assets.flpk` にまとめ、`_build/assets/` を1年キャッシュします。形式と規則は[docs/asset-archive.md](../../../docs/asset-archive.md)にあります。

## request context

entryはh3が読むRequestの `ip`、`waitUntil`、`runtime` を設定します。`getRequestEvent().clientAddress`、h3の `getRequestIP(event)`、`event.waitUntil` はそのまま使えます。bindingは `getRequestContext()` で読みます。

```ts
import { getRequestContext } from "fetchlet/solid-start/context";

const { clientAddress, env, waitUntil } = getRequestContext(); // API routeでは getRequestContext(event)
```

`FetchletBindings` をmodule augmentationで宣言すると `env` に型が付きます。SolidStartとsolid-jsは `node:async_hooks` を使うため、共通builderの `asyncContext: "serialized"` を有効にしています。

## 注意

SolidStartはAPI routeのGET / POSTなどをそれぞれ別のmoduleとしてbuildします。handler間で共有する状態は別moduleに置きます。
