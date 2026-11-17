# fetchlet/tanstack-start

TanStack Startのserver environmentをfetchlet用IIFEへbundleするVite pluginです。@tanstack/react-start 1.169.5 / @tanstack/react-router 1.170.46 / React 19.3.1を検証しています。

```ts
// vite.config.ts
import fetchletStart from "fetchlet/tanstack-start";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";

export default defineConfig({
  plugins: [tanstackStart(), react(), fetchletStart({ backend: "quickjs" })],
});
```

`backend` / `intl` は[共通builder](build.md)の同名設定です。

## 出力

clientを `build/client/`、serverを `node_modules/.cache/fetchlet-tanstack-start/` へbuildし、serverの `fetch` を接続した `build/server.js` と `build/fetchlet.json` を書きます。

SSR environmentは `worker` / `edge-light` 条件で依存をすべてbundleします。router-coreはserver用のbuildになります。`react-dom/server` は `react-dom/server.edge` に解決します（worker用のbuildは `MessageChannel` を使います）。Startがmodule評価時に読む `process.env.TSS_PRERENDERING` と `TSS_SHELL` は `"false"` に置き換えます。

`assets: true` はclient assetsを `assets.flpk` にまとめ、`assets/` を1年キャッシュします。形式と規則は[docs/asset-archive.md](../../../docs/asset-archive.md)にあります。

## request context

server function、server route、middlewareの `context` は `FetchletRequestContext` です。

| 値              | 内容                                                       |
| --------------- | ---------------------------------------------------------- |
| `clientAddress` | Rustのrequest contextの接続元                              |
| `env`           | Rustの固定binding                                          |
| `waitUntil`     | 応答後の処理の登録。Rustのbackground予算の範囲で完了を待つ |

```ts
import type { FetchletRequestContext } from "fetchlet/tanstack-start";

declare module "@tanstack/react-start" {
  interface Register {
    server: { requestContext: FetchletRequestContext<Bindings> };
  }
}
```

## 試験と次の対象

[examples/tanstack-start-axum](../../examples/tanstack-start-axum/README.md)が共通の10項目を確認します。prerender、SPA mode、Solid版のTanStack Startは個別の試験を追加して対応範囲に加えます。
