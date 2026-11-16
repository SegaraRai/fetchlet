# HonoX + axum

HonoXのfile-based routingとislandをaxumから配信する例です。[@fetchlet/hono](../../packages/hono/README.md)でserverをartifactにします。

## 起動

リポジトリのルートで実行します。

```powershell
vp install --frozen-lockfile
vp run example:honox-axum
```

http://127.0.0.1:3400 を開きます。taskはclient（`--mode client`）とserverの2回buildしてからサーバ（QuickJS）を起動します。

## 構成

| 場所           | 役割                                                |
| -------------- | --------------------------------------------------- |
| app/           | route、island、renderer、API route                  |
| vite.config.ts | HonoXとfetchletのVite pluginとVite+のtask           |
| src/           | axumの起動・binding・routing                        |
| config.json    | 待受、キュー、本文予算、期限、background予算、stack |
| tests/e2e.mjs  | 実HTTPと実ブラウザによる検証                        |
| build/         | server.js、client/、fetchlet.json                   |

HonoXのislandはclient routerを持たないため、/aboutへの遷移は文書の読み込みです。assetsは `/static/` から配信します。

config.jsonの `quickjs_stack_bytes`（4 MiB）と `worker_stack_bytes`（8 MiB）は[React Router例](../react-router-axum/README.md#stack)と同じ値です。このframeworkで必要な最小値は測定していません。

## 検証

```powershell
vp run browser:install
vp run test:example:honox-axum
```

SSRとescape、Rust serviceのbinding、assets、JSON endpoint、接続元とbinding、axum route、本文予算、streaming upload、`waitUntil`、並行Request、hydrationとnavigationを共通の10項目（tools/testing/common-checks.mjs）で確認します。結果はresults/example-honox-axum.jsonです。
