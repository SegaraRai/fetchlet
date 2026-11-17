# SolidStart + axum

SolidStart 2のstreaming SSR、`query` のserver function、API routeをaxumから配信する例です。[fetchlet/solid-start](../../packages/fetchlet/docs/solid-start.md)でserverをartifactにします。

## 起動

リポジトリのルートで実行します。

```powershell
vp install --frozen-lockfile
vp run @fetchlet-internal/example-solidstart-axum#serve
```

http://127.0.0.1:3600 を開きます。taskはbuildしてからサーバ（QuickJS）を起動します。

## 構成

| 場所                 | 役割                                                |
| -------------------- | --------------------------------------------------- |
| src/routes/          | page、API route、404 route                          |
| src/lib/completed.ts | API routeのhandler間で共有する状態                  |
| vite.config.ts       | SolidStartとfetchletのVite pluginとVite+のtask      |
| src/                 | axumの起動・binding・routing                        |
| config.json          | 待受、キュー、本文予算、期限、background予算、stack |
| tests/e2e.ts         | 実HTTPと実ブラウザによる検証                        |
| build/               | server.js、client/、fetchlet.json                   |

SolidStartはAPI routeのhandlerを別moduleにbuildするため、`/api/background` の状態は `src/lib/` に置いています。一致しないpathは `[...404].tsx` が404を返します。

config.jsonの `quickjs_stack_bytes`（4 MiB）と `worker_stack_bytes`（8 MiB）は[React Router例](../react-router-axum/README.md#stack)と同じ値です。このframeworkで必要な最小値は測定していません。

## 検証

```powershell
vp run browser:install
vp run test:examples -- solidstart-axum
```

SSRとescape、Rust serviceのbinding、assets、JSON endpoint、接続元とbinding、axum route、本文予算、streaming upload、`waitUntil`、並行Request、hydrationとnavigationを共通の10項目（tools/examples/common-checks.ts）で確認します。結果はresults/example-solidstart-axum.jsonです。
