# vinext + axum

vinext（Vite上のNext.js API実装）のApp Router、React Server Components、route handlerをaxumから配信する例です。[fetchlet/vinext](../../packages/fetchlet/docs/vinext.md)でserverをartifactにします。

## 起動

リポジトリのルートで実行します。

```powershell
vp install --frozen-lockfile
vp run @fetchlet-internal/example-vinext-axum#serve
```

http://127.0.0.1:3900 を開きます。taskはbuildしてからサーバ（QuickJS）を起動します。

## 構成

| 場所           | 役割                                                |
| -------------- | --------------------------------------------------- |
| app/           | layout、page、route handler                         |
| vite.config.ts | vinextとfetchletのVite pluginとVite+のtask          |
| src/           | axumの起動・binding・routing                        |
| config.json    | 待受、キュー、本文予算、期限、background予算、stack |
| tests/e2e.ts   | 実HTTPと実ブラウザによる検証                        |
| build/         | server.js、client/、fetchlet.json                   |

`/api/background` は `next/server` の `after()` で応答後の処理を登録します。config.jsonの `background_tasks` は64です。vinextは最初のrequestでroute moduleのpreloadごとに `waitUntil` を登録し、8では最初のページの描画が予算超過で失敗しました。

config.jsonの `quickjs_stack_bytes`（4 MiB）と `worker_stack_bytes`（8 MiB）は[React Router例](../react-router-axum/README.md#stack)と同じ値です。ReactのFizzがstack overflowから描画をやり直す深さに合わせています。

## 検証

```powershell
vp run browser:install
vp run test:examples -- vinext-axum
```

SSRとescape、Rust serviceのbinding、assets、JSON endpoint、接続元とbinding、axum route、本文予算、streaming upload、`waitUntil`、並行Request、hydrationとnavigationを共通の10項目（tools/examples/common-checks.ts）で確認します。結果はresults/example-vinext-axum.jsonです。
