# Waku + axum

WakuのReact Server Components、SSR、API routeをaxumから配信する例です。[@fetchlet/waku](../../packages/waku/README.md)でserverをartifactにします。

## 起動

リポジトリのルートで実行します。

```powershell
vp install --frozen-lockfile
vp run example:waku-axum
```

http://127.0.0.1:3800 を開きます。taskは`waku build` してからサーバ（QuickJS）を起動します。

## 構成

| 場所                | 役割                                                |
| ------------------- | --------------------------------------------------- |
| src/pages/          | page、layout、root、API route（`_api/`）            |
| src/waku.server.tsx | fetchletのserver entry adapter                      |
| vite.config.ts      | Vite+のtask（Wakuは `waku build` でbuildする）      |
| src/                | axumの起動・binding・routing                        |
| config.json         | 待受、キュー、本文予算、期限、background予算、stack |
| tests/e2e.mjs       | 実HTTPと実ブラウザによる検証                        |
| build/              | server.js、client/、fetchlet.json                   |

/ はrequestごとに描画するserver componentで、`getRequestContext()` からRustのbindingを呼びます。

config.jsonの `quickjs_stack_bytes`（4 MiB）と `worker_stack_bytes`（8 MiB）は[React Router例](../react-router-axum/README.md#stack)と同じ値です。ReactのFizzがstack overflowから描画をやり直す深さに合わせています。

## 検証

```powershell
vp run browser:install
vp run test:example:waku-axum
```

SSRとescape、Rust serviceのbinding、assets、JSON endpoint、接続元とbinding、axum route、本文予算、streaming upload、`waitUntil`、並行Request、hydrationとnavigationを共通の10項目（tools/testing/common-checks.mjs）で確認します。結果はresults/example-waku-axum.jsonです。
