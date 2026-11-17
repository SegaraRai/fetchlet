# fetchlet/qwik-city

Qwik City 1のSSR buildをfetchlet用IIFEへbundleするVite pluginとmiddlewareです。@builder.io/qwik / @builder.io/qwik-city 1.20.4を検証しています。

```ts
// vite.config.ts
import { fetchletAdapter } from "fetchlet/qwik-city/vite";

export default defineConfig({
  plugins: [
    qwikCity(),
    qwikVite({
      client: { outDir: "build/client" },
      ssr: { outDir: "node_modules/.cache/fetchlet-qwik-city" },
    }),
    fetchletAdapter({ backend: "quickjs" }),
  ],
});
```

```ts
// src/entry.fetchlet.tsx
import { createQwikCity } from "fetchlet/qwik-city/middleware";
import qwikCityPlan from "@qwik-city-plan";
import { manifest } from "@qwik-client-manifest";
import render from "./entry.ssr";

export default createQwikCity({ render, qwikCityPlan, manifest });
```

buildは `vp build && vp build --ssr` の2段です。`entry`（既定は `src/entry.fetchlet.tsx`）、`outDir`、`backend`、`intl` を設定できます。

## 出力

SSR buildで `entry` と `@qwik-city-plan` をbundleし、`build/server.js` と `build/fetchlet.json` を書きます。client buildでは、Qwikがmodule pathから付けるchunk名をRolldownが受け付ける名前に変えます（ファイル名はhashのみ）。

`assets: true` はclient assetsを `assets.flpk` にまとめ、`build/` と `assets/` を1年キャッシュします。形式と規則は[docs/asset-archive.md](../../../docs/asset-archive.md)にあります。

## request event

| 値                   | 内容                                                       |
| -------------------- | ---------------------------------------------------------- |
| `platform.env`       | Rustの固定binding                                          |
| `platform.waitUntil` | 応答後の処理の登録。Rustのbackground予算の範囲で完了を待つ |
| `clientConn.ip`      | Rustのrequest contextの接続元                              |
| `env.get(name)`      | 文字列のbinding                                            |

本文の上限はAppのrequest予算が持ちます。静的ファイルはRustサーバが配信し、Qwik Cityに届いて一致しないpathは404です。Qwik CityのCSRF検査はPOSTなどに `Origin` を要求します。

## 制限

Qwik 2（@qwik.dev/router）は次の対象です。
