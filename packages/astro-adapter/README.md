# @fetchlet/astro-adapter

Astroの公式server entrypoint APIでRequest / Responseを接続し、@fetchlet/buildで共通artifactを作ります。Astro 7.4.12のserver outputを検証しています。

```js
import { defineConfig } from "astro/config";
import fetchletAdapter from "@fetchlet/astro-adapter";

export default defineConfig({
  output: "server",
  adapter: fetchletAdapter({
    backend: "quickjs",
    intl: { locales: ["en", "ja"], timeZoneData: "golden" },
  }),
});
```

Rustの固定bindingはAstro.locals.envへ渡します。clientAddressは呼び出し固有のcontext、getSecretは固定した文字列bindingへ接続します。本文はbuffered profileです。

AstroのIntl.DateTimeFormat要求を共通builderへ渡します。backendがquickjs / boaならFormatJSと依存API、選択したlocale・タイムゾーンデータを追加します。v8ならnative Intlを使います。backendの既定値portableは、いずれのVMでも補えるbundleを作ります。Rust側のbackendとbuild設定を合わせると、native APIを活かしてbundleを小さくできます。

examples/astro-axumはQuickJS＋FormatJSで、SSR、Svelte island、フォーム、Cookie、endpoint、client navigationを試験します。

画像変換、server islands、session、static output等は個別の能力と試験を追加する対象です。現在の実測範囲は例の9項目です。

[Astro adapter API](https://docs.astro.build/en/reference/adapter-reference/)と[server entrypoint API](https://docs.astro.build/en/reference/modules/astro-app/)を使っています。
