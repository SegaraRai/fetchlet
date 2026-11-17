# React Router + axum

React Router（framework mode）でHTMLとresource routeを作り、axumから配信する例です。[fetchlet/react-router](../../packages/fetchlet/docs/react-router.md)でserver buildをartifactにします。React componentのhydration、Form、遅延データ、client navigationを操作できます。

## 起動

リポジトリのルートで実行します。

```powershell
vp install --frozen-lockfile
vp run @fetchlet-internal/example-react-router-axum#serve
```

http://127.0.0.1:3300 を開きます。taskはReact Routerをbuildしてからサーバ（QuickJS）を起動します。

## 構成

| 場所                   | 役割                                                   |
| ---------------------- | ------------------------------------------------------ |
| app/                   | route、component、`entry.server.tsx`、load contextの型 |
| react-router.config.ts | React Routerの設定とfetchlet preset                    |
| vite.config.ts         | React RouterのVite pluginとVite+のtask                 |
| src/                   | axumの起動・binding・routing                           |
| config.json            | 待受、キュー、本文予算、期限、background予算、stack    |
| tests/e2e.js           | 実HTTPと実ブラウザによる検証                           |
| build/                 | server.js、client/、fetchlet.json（server/は中間出力） |

## routeとcontext

| route           | 内容                                                                             |
| --------------- | -------------------------------------------------------------------------------- |
| /               | loaderが `context.env.RUST` を呼ぶ。actionがCookieを設定する                     |
| /deferred       | loaderのPromiseを `<Await>` で表示し、shellの後に同じResponseで値を送る          |
| /api/echo       | JSONを201で返すresource route                                                    |
| /api/context    | `context.clientAddress` と `context.env.MESSAGE` を返す                          |
| /api/upload     | 受信中の本文を数える。宣言のある予算超過は413、宣言の無い超過は `LIMIT_EXCEEDED` |
| /api/background | `context.waitUntil` で応答後の処理を登録する                                     |

`app/entry.server.tsx` は `react-dom/server.edge` の `renderToReadableStream` で描画します。crawlerにはすべて描画してから返します。

## stack

config.jsonの `quickjs_stack_bytes`（4 MiB）と `worker_stack_bytes`（8 MiB）はReactの再帰の深さに合わせた値です。QuickJSの既定の1 MiBでは、Rustのdebug buildでReactがstack overflowから描画をやり直し、head内に `<link` の断片が残りました（2 MiBで解消、release buildは1 MiBでも発生せず）。worker threadのstackはQuickJSの上限より大きくします。詳細は[preset](../../packages/fetchlet/docs/react-router.md)を参照してください。

## 検証

```powershell
vp run browser:install
vp run test:examples -- react-router-axum
```

SSRとescape、hoistされたlinkの完全性、assets、遅延データのstreaming、resource route、document actionとCookie、load context、axum route、本文予算、streaming upload、`waitUntil`、並行Request、hydrationとclient action / navigationを12項目で確認します。結果はresults/example-react-router-axum.jsonです。
