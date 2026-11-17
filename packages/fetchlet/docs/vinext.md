# fetchlet/vinext

[vinext](https://github.com/cloudflare/vinext)（Vite上のNext.js API実装）のApp Router serverをfetchlet用IIFEへbundleするVite pluginです。vinext 1.4.6 / React 19.3.1を検証しています。

```ts
// vite.config.ts
import fetchletVinext from "fetchlet/vinext";
import vinext from "vinext";

export default defineConfig({
  plugins: [vinext(), fetchletVinext({ backend: "quickjs" })],
});
```

`backend` / `intl` / `outDir` は[共通builder](build.md)と同じ設定です。

## 出力

vinextが全environmentをbuildした後に、`dist/server/index.js` を接続した `build/server.js` と `build/fetchlet.json` を書き、`dist/client` を `build/client` へ複製します。rsc / ssr environmentと再bundleは `workerd` / `edge-light` / `worker` 条件で依存を解決します（`react-dom/server.edge` など）。

`assets: true` はclient assetsを `assets.flpk` にまとめ、`_next/static/` を1年キャッシュします。形式と規則は[docs/asset-archive.md](../../../docs/asset-archive.md)にあります。

## Node API

vinextのserverはCloudflare Workersの `nodejs_compat` を前提にNode APIを使います。pluginはartifactのbundleで次のように置き換えます。

| module / 値   | 置き換え                                                           |
| ------------- | ------------------------------------------------------------------ |
| `node:path`   | pathe 2.0.3（posix / win32）                                       |
| `node:fs`     | ファイルが存在しないfs。vinextはmemory上のcacheを使う              |
| `node:buffer` | buffer 6.0.3と、厳密なTextDecoderによる `isUtf8`                   |
| `node:crypto` | @noble/hashes 2.4.0によるSHA-256の `createHash`（cache keyに使用） |
| `node:module` | vinextがSSR buildで外部に残すReactのentryを返す `createRequire`    |
| `process.env` | 空のobject。`process.platform` は `"linux"`                        |

`globalThis.fetch` の置き換え（Next.jsのfetch cache）はfetchletのruntimeが許可しています。置き換えたfetchも最終的にhostのfetchを呼び、RustのFetchPolicyがすべての送信を認可します。

## request context

```ts
import { getRequestContext } from "fetchlet/vinext/context";

const { clientAddress, env, waitUntil } = getRequestContext();
```

server component、route handler、server actionで使えます。`next/server` の `after()` は `waitUntil` に接続されます。

## 予算

vinextは最初のrequestでroute moduleのpreloadごとに `waitUntil` を登録します。[examples/vinext-axum](../../examples/vinext-axum/README.md)は `background_tasks` を64にしています（8では最初のページの描画が予算超過で失敗しました）。

## 制限

Pages Router、ISRのファイル永続化、`next/image` の最適化、middlewareは未検証です。Next.js本体（`next build`）の出力は対象外です。
