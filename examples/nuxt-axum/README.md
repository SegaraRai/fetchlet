# Nuxt + axum

NuxtでHTMLとserver routeを作り、axumから配信する例です。NuxtのNitroを[fetchlet/nitro](../../packages/fetchlet/docs/nitro.md)でbuildします。Vue componentのhydration、フォーム、client navigationを操作できます。

## 起動

リポジトリのルートで実行します。

```powershell
vp install --frozen-lockfile
vp run @fetchlet-internal/example-nuxt-axum#serve
```

http://127.0.0.1:3200 を開きます。taskはNuxtをbuildしてからRustサーバ（QuickJS）を起動します。

## 構成

| 場所           | 役割                                                     |
| -------------- | -------------------------------------------------------- |
| web/           | Nuxtのページ、component、server route、public files      |
| nuxt.config.ts | srcDir / serverDir、runtime config、Nitro preset         |
| vite.config.ts | Vite+のtask                                              |
| src/           | axumの起動・binding・routing                             |
| config.json    | 待受、キュー、本文予算、期限、background予算、メッセージ |
| tests/e2e.ts   | 実HTTPと実ブラウザによる検証                             |
| build/         | server.js、client/、fetchlet.jsonの生成先                |

axumは `build/client` の静的ファイルと `/api/rust` を先に扱い、残りをFetchletServiceでNuxtへ渡します。

## bindingとcontext

- Rustは `NUXT_MESSAGE` と `RUST` serviceを固定bindingとして渡します。`NUXT_MESSAGE` はNuxtのruntime config `message` を上書きします。
- `/api/greeting` はruntime configと `event.context.fetchlet.env.RUST` を使います。ページは `useFetch` でこのrouteを呼び、Nitro内部の呼び出しでもbindingを引き継ぎます。
- `/api/context` は `getRequestIP(event)` で接続元を返します。
- `/greet` はフォームのPOSTでCookieを設定し、303でページへ戻します。
- `/api/upload` は `getRequestWebStream(event)` で受信中の本文を数えます。Content-Lengthで予算超過を宣言した本文は実行前に413、宣言のない超過はstreamのエラー（`LIMIT_EXCEEDED`）です。
- `/api/background` は `event.waitUntil` で応答後の処理を登録します。

## 検証

```powershell
vp run browser:install
vp run test:examples -- nuxt-axum
```

SSRとescape、runtime config、Rust service、assets、JSON route、フォームとCookie、接続元とbinding、axum route、本文予算、streaming upload、`event.waitUntil`、並行Request、hydrationとclient navigationを11項目で確認します。結果はresults/example-nuxt-axum.jsonです。
