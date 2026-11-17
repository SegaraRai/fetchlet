# SvelteKit + axum

SvelteKitでHTMLを生成し、axumがHTTPとJS / CSSを配信する例です。ブラウザでカウンターとフォームを操作し、別ページへのクライアント遷移を試せます。

## 起動

リポジトリのルートで実行します。

```powershell
vp install --frozen-lockfile
vp run @fetchlet-internal/example-sveltekit-axum#serve
```

`http://127.0.0.1:3000` を開きます。taskはSvelteKitをbuildしてからRustサーバを起動します。終了はCtrl+Cです。

## 構成

| 場所           | 役割                                                                   |
| -------------- | ---------------------------------------------------------------------- |
| web/           | SvelteKitのページ、action、endpoint、公開ファイル                      |
| vite.config.ts | SvelteKitとfetchlet adapterのbuild設定                                 |
| src/           | axumのrouting、本文変換、公開handle / HTTP adapterの利用、Rust service |
| config.json    | 待受、キュー、本文予算、期限、env                                      |
| tests/e2e.ts   | 実HTTPと実ブラウザによる検証                                           |
| build/         | server.js、client/、fetchlet.jsonの生成先                              |

Rustの `/api/rust` とSvelteKitのrouteを同じサーバで扱います。静的ファイルを先に配信し、動的なRequestをJSへ渡します。POST等もSvelteKitへ配送します。

## bindingとcontext

Rustが `MESSAGE` と `RUST` serviceを固定bindingとして渡します。adapterはSvelteKitの `platform.env` に接続し、文字列のbindingをserver初期化のenvへ渡します。ページのloadはRust serviceから挨拶を取得します。

接続元IPは `App::fetch_with_context` の引数で渡し、adapterが `getClientAddress()` へ接続します。共有globalへのリクエスト情報の書き換えを伴わない方式です。

## プロセス内のRust API

`src/services.rs` の `api_router` は、Rust APIを一つのaxum routerとして定義します。

- サーバは同じrouterを `/api/v1` へmountし、ブラウザーへ公開します。
- `OriginRouter::internal("https://rust.fetchlet.test", router_transport(...))` で同じrouterをプロセス内に登録し、`RUST` bindingとglobal fetchの両方へ渡します。policyはこのoriginだけを許可します。
- JSからの呼び出しはsocketを使わずにrouterへ届き、Rustのアプリ状態を共有します。
- `FetchletService::trusted_context` が接続元IPから `Caller` を作り、`fetchlet::Context` としてSSRのInvocationへ渡します。`/caller` handlerはこのContextだけを使い、headersは参照しません。

| route                    | 内容                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------ |
| /projects                | loadが `event.fetch` で一覧を取得し、actionが `RUST.fetch` で追加する。空の名前は400 |
| /api/projects/[id]       | Rust APIのResponseをそのまま返す。存在しないidは404                                  |
| /api/in-process/failure  | Rust handlerの500がそのままResponseとして届く                                        |
| /api/in-process/caller   | `x-forwarded-for` を付けても、Contextの接続元（127.0.0.1）が返る                     |
| /api/in-process/denied   | 許可外originはbinding、global fetch、`event.fetch` のいずれも `PERMISSION_DENIED`    |
| /api/in-process/abort    | 50 msでabortし、同じInvocation内の次の呼び出しでRust handlerのdropを確認する         |
| /api/in-process/internal | 同一originの `event.fetch` はSvelteKitがJS内で処理し、Rust APIを呼ばない             |
| /api/v1/*                | 同じrouterの公開HTTP。`/api/v1/caller` はContextがないため401                        |
| /api/v1/stats            | Rust APIの呼び出し数とcancel数（プロセス内の `/stats` と同じ値）                     |

HTTPエラーはResponse、権限拒否・cancel・transportのエラーはrejectとしてJSへ届きます。

## 応答後の処理

`/api/background` は `platform.context.waitUntil` で応答後の処理を登録し、同じworkerは次のリクエストの前にその処理を完了します。予算はconfig.jsonのbackground_timeout_ms（5秒）とbackground_tasks（8件）です。

## 設定と実行管理

`config.json` はこのローカル例の運用設定です。queue_capacityは8、Request本文は1 MiB、協調的期限は10秒を選んでいます。小さなページとフォームを扱う例の設定として、用途に応じて変更できます。本文と期限はnullでホスト側の管理へ委ねられます。

AppHandleが所有スレッド、キュー、キャンセルとInstance再生成を担当します。FetchletServiceがaxumのHTTP本文とcontextを接続します。例は公開APIを利用します。

別の設定を使う場合は、build後にRustサーバへ設定ファイルを渡します。

```powershell
node tools/workspace/cargo.ts run --locked -p example-sveltekit-axum -- path/to/config.json
```

build_directoryは設定ファイルからの相対パス、または絶対パスです。public_originを設定すると、proxyの外側の公開originをRequestに使います。既定は実際のlisten先です。

cookieはローカルHTTP用です。HTTPSの構成ではactionのcookieをsecureに設定します。現在のprofileはSvelteの同期renderingとbuffered本文を使います。非同期actionは試験に含みます。streaming、server側asset read、強制的なCPU停止は共通基盤の拡張対象です。

## E2E試験

```powershell
vp run browser:install
vp run test:examples -- sveltekit-axum
```

インストール済みChromeを使う場合は `FETCHLET_BROWSER_CHANNEL=chrome` を環境変数に設定します。

検査するのはSSRとescape、JS / CSS / 静的ファイル、JSON endpoint、form actionとSet-Cookie、client addressとenv、Rust route、本文予算、応答後の処理、プロセス内Rust API（公開HTTPとの共用、HTTPエラー、信頼できるContext、origin policy、cancel、`event.fetch` の分担）、並行Request、hydrationとフォーム送信、クライアント遷移です。結果は `results/example-sveltekit-axum.json` に保存します。

adapterの入口は[SvelteKit adapter API](https://svelte.dev/docs/kit/writing-adapters)、HTTPと静的配信は[axum](https://docs.rs/axum/0.8.9/axum/)と[ServeDir](https://docs.rs/tower-http/0.7.1/tower_http/services/struct.ServeDir.html)を使用しています。
