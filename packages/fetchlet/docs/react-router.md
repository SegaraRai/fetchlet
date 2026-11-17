# fetchlet/react-router

React Router（framework mode）のserver buildをfetchlet用IIFEへbundleするReact Router presetです。React Router 7.18.5 / React 19.3.1を検証しています。

```ts
// react-router.config.ts
import type { Config } from "@react-router/dev/config";
import { fetchletPreset } from "fetchlet/react-router";

export default {
  presets: [fetchletPreset({ backend: "quickjs" })],
} satisfies Config;
```

`backend` / `intl` は[共通builder](build.md)の同名設定です。presetは `ssr: true` と1つのserver bundleを前提にし、`serverBundles` や `ssr: false` はbuild時にエラーにします。

## 出力

React Routerの `buildEnd` で、`build/server/` のserver buildを `createRequestHandler` に接続し、`build/server.js` と `build/fetchlet.json` を書きます。`build/client/` はReact Routerのclient assetsです。`build/server/` は中間出力で、Rustサーバからは配信しません。アプリの設定で `buildEnd` を定義すると、presetのartifact生成を置き換えます。

## load context

loader / actionのcontextは `FetchletLoadContext` です。

| 値              | 内容                                                       |
| --------------- | ---------------------------------------------------------- |
| `clientAddress` | Rustのrequest contextの接続元                              |
| `env`           | Rustの固定binding                                          |
| `waitUntil`     | 応答後の処理の登録。Rustのbackground予算の範囲で完了を待つ |

```ts
import type { FetchletLoadContext } from "fetchlet/react-router/context";

declare module "react-router" {
  interface AppLoadContext extends FetchletLoadContext<Bindings> {}
}
```

`future.v8_middleware` を有効にしたアプリでは、contextが `RouterContextProvider` になり、`context.get(fetchletContext)` で同じ値を読みます。Viteがserver buildへこのmoduleを別にbundleしても、keyはglobalのsymbol registryで共有します。

## 描画とQuickJSのstack

`entry.server` で `react-dom/server.edge` の `renderToReadableStream` を使うと、Suspenseの遅延データを同じResponseでstreamingできます。応答本文はRustのHTTP応答へstreamのまま渡ります。

ReactのFizzはstackのoverflowを捕捉して要素の描画をやり直します。やり直す前に書いた `<link` の断片がhead内に残り、HTTP 200のまま壊れたHTMLになります。QuickJSの既定のstack上限1 MiBでは、Rustのdebug buildで小さなページでも発生し、release buildでは発生しませんでした（examples/react-router-axumの `/about`、2 MiBで解消）。例は `QuickJsOptions::stack_limit_bytes` 4 MiBとworker threadのstack 8 MiBを設定し、E2Eで断片が無いことを確認しています。

## 試験と次の対象

[examples/react-router-axum](../../examples/react-router-axum/README.md)が12項目を確認します。対象はSSR、assets、遅延データのstreaming、resource route、document / client action、Cookie、load context、streaming upload、`waitUntil`、hydration、client navigationです。`future.v8_middleware` の経路は手動で確認しました。自動試験は次の対象です。

React Router 8系、server bundleの分割、prerender、RSC modeは個別の試験を追加して対応範囲に加えます。
