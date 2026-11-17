# fetchlet/waku

Wakuのserver entry adapterです。WakuのRSC serverをfetchlet用IIFEへbundleします。waku 1.0.0-rc.5 / React 19.3.1を検証しています。

```tsx
// src/waku.server.tsx
import adapter from "fetchlet/waku";
import { fsRouter } from "waku";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("/src/pages/**/*.{tsx,ts}")).map(([key, load]) => [
    key.slice("/src/".length),
    load,
  ]),
);

export default adapter(fsRouter(modules), { backend: "quickjs" });
```

`backend` / `intl` / `outDir` は[共通builder](build.md)と同じ設定です。`middlewareFns` / `middlewareModules` はWakuの他のadapterと同じです。buildは `waku build` です。

## 出力

Wakuのstatic generationの後に、`dist/server/index.js` を接続した `build/server.js` と `build/fetchlet.json` を書き、`dist/public` を `build/client` へ移動します。Wakuは `dist/public` の名前を固定しており、client buildと生成したページをそこへ書くためです。

`assets: true` はclient assetsを `assets.flpk` にまとめ、`assets/` を1年キャッシュします。形式と規則は[docs/asset-archive.md](../../../docs/asset-archive.md)にあります。

## request context

```ts
import { getRequestContext } from "fetchlet/waku/context";

const { clientAddress, env, waitUntil } = getRequestContext();
```

server component、server function、API routeで現在のrequestのcontextを返します。WakuはAPI handlerへRequestの複製を渡すため、引数なしで呼びます。Hono middlewareでは `c.env` がbinding、`c.executionCtx.waitUntil` が応答後の処理の登録です。文字列のbindingはWakuの `getEnv(name)` でも読めます。Wakuの `node:async_hooks` は共通builderの `asyncContext: "serialized"` で置き換えます。

本文の上限はAppのrequest予算が持ちます。adapterはHonoの `bodyLimit` を使いません。
