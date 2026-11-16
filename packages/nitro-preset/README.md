# @fetchlet/nitro-preset

Nitroのサーバをfetchlet用IIFEへbundleするNitro presetです。Nuxtのように内部でNitroを使うframeworkも、`nitro.preset` の指定で同じartifactを出力します。Nuxt 4.6.4 / nitropack 2.13.6 / h3 1.15.11を検証しています。

```ts
/// <reference types="@fetchlet/nitro-preset/types" />

export default defineNuxtConfig({
  nitro: {
    preset: "@fetchlet/nitro-preset",
    fetchlet: { backend: "quickjs" },
  },
});
```

Nitro単体では `nitro.config.ts` に同じ `preset` と `fetchlet` を書きます。`fetchlet.backend` / `fetchlet.intl` は[共通builder](../build/README.md)の同名設定です。

## 出力

出力先は `build/` です。`server.js`、`client/`（Nitroのpublic assets）、`fetchlet.json` を書き、Nitroの `nitro.json` はfetchlet.jsonに置き換えます。Rust側のFetch entryは `handle` です。Nitroのserver bundleは `.nuxt/fetchlet/server`（Nuxtの場合）に作り、@fetchlet/buildがWeb API profileの後に評価するよう再bundleします。public assetsはRustサーバが配信するため、Nitroの `serveStatic` は無効です。

## Requestとcontext

- h3の `toWebHandler` でRequestをNitroへ渡します。Request本文は受信中のstreamのままで、`getRequestWebStream(event)` で読めます。`readBody` 等は本文を回収して使います。
- contextのclientAddressは `event.context.clientAddress` になり、h3の `getRequestIP(event)` が返します。
- Rustの固定bindingは `event.context.fetchlet.env` です。型はアプリが `FetchletBindings` を拡張して宣言します。

  ```ts
  import type { ServiceBinding } from "@fetchlet/nitro-preset/types";

  declare module "@fetchlet/nitro-preset/types" {
    interface FetchletBindings {
      NUXT_MESSAGE: string;
      RUST: ServiceBinding;
    }
  }
  ```

- 文字列bindingはNitroの `process.env` から読めます。Nuxtのruntime configは `NUXT_` で始まるbindingで上書きできます。
- `event.waitUntil(promise)` はfetchletの `waitUntil` へ登録します。Rustの `Limits::background_timeout` / `background_tasks` が予算です。
- `useFetch` / `$fetch` によるNitro内部の呼び出しでも、`event.context.fetchlet` とclientAddressを引き継ぎます。

## 試験と次の対象

[examples/nuxt-axum](../../examples/nuxt-axum/README.md)がQuickJSで、SSR、assets、server route、Cookie、runtime config、Rust service binding、streaming upload、`event.waitUntil`、hydration、client navigationを11項目で確認します。描画はVueの `renderToString` によるbuffered profileです。

Nitro 3（h3 2）系、応答本文のstreaming、WebSocket、scheduled taskは個別の試験を追加して対応範囲に加えます。
