# TanStack Start + axum

TanStack Start（React）のstreaming SSR、server function、server routeをaxumから配信する例です。[fetchlet/tanstack-start](../../packages/fetchlet/docs/tanstack-start.md)でserverをartifactにします。

## 起動

リポジトリのルートで実行します。

```powershell
vp install --frozen-lockfile
vp run @fetchlet-internal/example-tanstack-start-axum#serve
```

http://127.0.0.1:3500 を開きます。taskはbuildしてからサーバ（QuickJS）を起動します。

## 構成

| 場所           | 役割                                                      |
| -------------- | --------------------------------------------------------- |
| src/routes/    | route、server route（`server.handlers`）                  |
| src/context.ts | request contextの型登録                                   |
| vite.config.ts | TanStack Start、React、fetchletのVite pluginとVite+のtask |
| src/           | axumの起動・binding・routing                              |
| config.json    | 待受、キュー、本文予算、期限、background予算、stack       |
| tests/e2e.mjs  | 実HTTPと実ブラウザによる検証                              |
| build/         | server.js、client/、fetchlet.json                         |

/ のloaderはserver functionで `context.env.RUST` を呼びます。client navigationでもserver functionがRustのbindingを使います。

config.jsonの `quickjs_stack_bytes`（4 MiB）と `worker_stack_bytes`（8 MiB）は[React Router例](../react-router-axum/README.md#stack)と同じ値です。ReactのFizzがstack overflowから描画をやり直す深さに合わせています。

## 検証

```powershell
vp run browser:install
vp run test:examples -- tanstack-start-axum
```

SSRとescape、Rust serviceのbinding、assets、JSON endpoint、接続元とbinding、axum route、本文予算、streaming upload、`waitUntil`、並行Request、hydrationとnavigationを共通の10項目（tools/examples/common-checks.ts）で確認します。結果はresults/example-tanstack-start-axum.jsonです。
