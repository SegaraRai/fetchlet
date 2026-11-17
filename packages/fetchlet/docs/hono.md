# fetchlet/hono

Hono / HonoXのアプリをfetchlet用IIFEへbundleするVite pluginです。`@hono/vite-build` 1.11.1でアプリをbuildしてから、[共通builder](build.md)でartifactにします。hono 4.13.19 / honox 0.1.62を検証しています。

```ts
// vite.config.ts
import fetchletBuild from "fetchlet/hono/vite";

export default defineConfig(({ mode }) => ({
  plugins: [honox(), fetchletBuild({ entry: "./app/server.ts", backend: "quickjs" })],
}));
```

`entry` は `export default app` するmoduleです。`backend` / `intl` は共通builderの同名設定、`external` は `@hono/vite-build` に渡します。`functions` に指定したmoduleのnamed exportは、Fetch handlerと並んでRustの `App::call` / `AppHandle::call` から呼べる関数になります（`handle` は予約名）。[HonoX + Tauri](../../examples/honox-tauri/README.md)が使います。

## 出力

`build/server.js` と `build/fetchlet.json` を書きます。公開ファイルはRustサーバが配信するため、`staticPaths` は空にしています。HonoXではclient buildを `build/client` へ出力します。

## Rustからの値

| 値                         | 内容                                                          |
| -------------------------- | ------------------------------------------------------------- |
| `c.env`                    | Rustの固定binding                                             |
| `c.executionCtx.waitUntil` | 応答後の処理の登録。Rustのbackground予算の範囲で完了を待つ    |
| `getConnInfo(c)`           | `fetchlet/hono/conninfo`。Rustのrequest contextの接続元を返す |
| `getRequestContext(c)`     | `fetchlet/hono/conninfo`。Rustのrequest context               |

HonoXは `node:async_hooks` の `AsyncLocalStorage` でcontextを保持します。共通builderの `asyncContext: "serialized"` で、1つのinvocationの間だけstoreを保持する実装に置き換えます。

## 制限

HonoXのclient manifestは `build/client/.vite/manifest.json` に置かれ、Rustの静的配信から取得できます。manifestはassetのファイル名とmoduleの対応だけを含みます。
