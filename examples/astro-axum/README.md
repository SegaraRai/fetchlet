# Astro + axum

Astroで動的なHTMLとendpointを作り、axumから配信する例です。Svelte islandをhydrationし、カウンター、フォーム、Astroのclient navigationを操作できます。

## 起動

リポジトリのルートから実行します。

```powershell
vp install --frozen-lockfile
vp run @fetchlet-internal/example-astro-axum#serve
```

http://127.0.0.1:3100 を開きます。Rust側はQuickJSを使用します。AstroのIntl.DateTimeFormat要求と依存APIは、adapterがFormatJSで補います。SvelteKit例のQuickJSと同じAppHandle / fetchlet-http APIを使います。

## 構成と設定

web/がAstroのページ、endpoint、Svelte component、assetsです。astro.config.jsでbackendをquickjsへ合わせ、Intlのlocaleとタイムゾーンデータも構成できます。既定はenとUTCです。V8向けのbuildではbackend: "v8"を選ぶとFormatJSがbundleから外れ、Rust側もBackend::v8()とv8 featureへ揃えます。設定は[共通builder](../../packages/fetchlet/docs/build.md)を参照してください。

astro.config.jsがframework設定、vite.config.tsがVite+ taskを持ちます。src/はRustの起動・binding・routingだけを担当します。

AppHandleが所有スレッド、キュー、キャンセルとInstance再生成を管理します。FetchletServiceがHTTP変換とclient addressを渡します。RustサービスとMESSAGEはAstro.locals.envから使います。

config.jsonで待受、キュー、本文予算、期限、出力先を設定します。このローカル例はキュー8件、Request本文1 MiB、協調的期限10秒を選んでいます。public_originはproxyの外側のorigin指定に使えます。詳細な設定方法はSvelteKit例と共通です。

AstroとSvelte 5の同期SSRを使い、本文はRustへbufferとして返します。Request本文は `stream_request_bodies()` でendpointへReadableStreamとして渡し、`/api/upload` が受信しながら数えます。Content-Lengthで予算超過を宣言した本文は実行前に413、宣言のない超過はendpointのstreamのエラーとして扱います。`/api/background` は `Astro.locals.waitUntil` で応答後の処理を登録し、同じworkerは次のリクエストの前にその処理を完了します（config.jsonのbackground_timeout_ms / background_tasksが予算）。Svelte islandはSSR後にブラウザでhydrationします。cookieはローカルHTTP用で、HTTPSではsecureを設定します。

## 検証

```powershell
vp run browser:install
vp run test:examples -- astro-axum
```

インストール済みChromeにはFETCHLET_BROWSER_CHANNEL=chromeを指定できます。SSR、escape、assets、JSON endpoint、フォーム、Cookie、context、Rust route、予算、並行Request、island hydrationとclient navigationを9項目で確認します。

結果はresults/example-astro-axum.jsonです。画像変換やserver islands等の拡張は、対応範囲ごとの試験を追加して進めます。
