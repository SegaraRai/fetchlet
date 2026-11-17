# Qwik City + axum

Qwik Cityのresumable SSR、`routeLoader$`、endpointをaxumから配信する例です。[fetchlet/qwik-city](../../packages/fetchlet/docs/qwik-city.md)でserverをartifactにします。

## 起動

リポジトリのルートで実行します。

```powershell
vp install --frozen-lockfile
vp run @fetchlet-internal/example-qwik-city-axum#serve
```

http://127.0.0.1:3700 を開きます。taskはclient buildとSSR build（`vp build --ssr`）をしてからサーバ（QuickJS）を起動します。

## 構成

| 場所                   | 役割                                                |
| ---------------------- | --------------------------------------------------- |
| src/routes/            | page、layout、endpoint（`onGet` / `onPost`）        |
| src/entry.fetchlet.tsx | fetchletのserver entry                              |
| vite.config.ts         | Qwik、Qwik City、fetchletのVite pluginとVite+のtask |
| src/                   | axumの起動・binding・routing                        |
| config.json            | 待受、キュー、本文予算、期限、background予算、stack |
| tests/e2e.js           | 実HTTPと実ブラウザによる検証                        |
| build/                 | server.js、client/、fetchlet.json                   |

Qwikはhydrationせずにresumeします。counterの `data-hydrated` は `useVisibleTask$` が設定します。Qwikはcomponentのstyleをinline化し、chunkを `/build/` から読みます。

config.jsonの `quickjs_stack_bytes`（4 MiB）と `worker_stack_bytes`（8 MiB）は[React Router例](../react-router-axum/README.md#stack)と同じ値です。このframeworkで必要な最小値は測定していません。

## 検証

```powershell
vp run browser:install
vp run test:examples -- qwik-city-axum
```

SSRとescape、Rust serviceのbinding、assets、JSON endpoint、接続元とbinding、axum route、本文予算、streaming upload、`waitUntil`、並行Request、hydrationとnavigationを共通の10項目（tools/examples/common-checks.ts）で確認します。結果はresults/example-qwik-city-axum.jsonです。
