# Host services

2026-11-16。開発中の公開APIと、その所有権・通信契約を説明します。

## Appとbinding

`App` はmodule、Instance、固定binding、資源予算を保持します。呼び出しごとにInvocationを作り、その呼び出しで開始するRust Futureを所有します。

```rust,ignore
use fetchlet::{
    App, Backend, Body, FetchPolicy, FetchService, HostServices,
    Module, Response, transport_fn,
};

let policy = FetchPolicy::deny_all()
    .allow_origin("https://api.example.test")?;

let service = FetchService::new(
    transport_fn(|request| async move {
        let message = format!("handled {}", request.uri().path());
        Ok(Response::new(Body::from(message)))
    }),
    policy,
);

let hosts = HostServices::new()
    .outbound(service.clone())
    .service("API", service)?
    .env("APP_ENV", "production")?;

let mut app = App::builder(Backend::quickjs())
    .module(Module::new(bundle))
    .host_services(hosts)
    .build()?;
```

JSでは `fetch(url, init)`、`fetchlet.env.API.fetch(url, init)`、`fetchlet.env.APP_ENV` を使います。bindingはmodule評価前に設置する読み取り専用のnull-prototype objectです。公開するenvの値とserviceはRust側で指定します。JSが読む必要のある値をenvへ渡し、上流の認証情報はRust側のcredentials callbackへ保持します。

Appは `&mut self` による直列実行です。QuickJSとBoaは呼び出し側が所有するスレッドで動作し、V8はisolate専用workerを持ちます。AppHandleでは所有スレッドとキューをライブラリが管理します。poolは今後の拡張対象です。

## bundleの入口

現在のmoduleはビルド済みIIFEで、`fetchletExports` に公開関数を置きます。任意関数には `App::call` / `call_json`、Fetchには既定名 `handle` のwire adapterを使います。入口名は `AppBuilder::fetch_handler` で選択します。

Fetch adapterはURL、method、header pairs、本文バイト列をWeb Requestへ変換し、Web Responseを逆変換します。`fixtures/hono.tsx` と `fixtures/sveltekit/entry.ts` が例です。workspaceの `@fetchlet/runtime/adapter` は標準Fetchハンドラを接続し、`@fetchlet/sveltekit-adapter` はserver bundleとclient assetsを生成します。実行例は `examples/sveltekit-axum/` にあります。

## プロセス内のRust関数を呼ぶ

上のtransport_fnの例は、Rust関数が直接Responseを作る構成です。HostServices::outboundへ渡せばglobal fetchから、serviceへ登録すればfetchlet.env.API.fetchから利用できます。内部呼び出しのためのHTTP接続やlistenを用意せず、同じFetchServiceの認可・資源予算を適用できます。

`OriginRouter` はoriginの完全一致でtransportを選び、登録したoriginだけを許可するserviceを作ります。internal routeは、`App::fetch` に渡したRequestのextensionsにある `Context`（認証主体等、JSから読めない値）をrequest extensionsで受け取ります。`fetchlet_axum::router_transport` は同じaxum routerを公開HTTPとプロセス内fetchで共用します。host fetchの処理中に同じ `AppHandle` を呼ぶと `Error::Reentrant` になります。詳細は[プロセス内fetch](in-process-fetch.md)を参照してください。

## fetchの処理順序

1. JS Requestの本文を読み取り、設定された本文・chunk・message予算を検査する。
2. Invocationのsubrequest予算を消費し、serviceを選択する。
3. Rustのrewrite callbackでRequestを書き換える。
4. 書き換え後のorigin、method、header、本文を検査する。
5. credentials callbackで認証情報を付け、transport用headerを整理する。
6. single-hop transportを実行する。
7. redirectを追う場合は、認証付与前のRequestを基に次のRequestを作り、同じ検査を行う。

originはscheme / host / portの正規化後の完全一致で判定します。credentials callbackが追加したheaderの寿命は一回の送信です。別originへのredirectでは、guestが指定したAuthorization、Cookie等も除去します。

`FetchService::rewrite` は認可前、`credentials` は認可後に実行します。credentials callbackでは渡されたURLに応じて秘密の送信先を限定します。

## transportの契約

transportはRust側が信頼する実装を渡します。必要な契約は、single-hopの応答、Futureのdropによる処理中断、受信中の本文予算の適用です。実HTTP clientを接続するときは、DNS解決結果と実際の接続先IPも検査します。origin policyはURLの認可を担当し、ネットワーク到達性の制御はtransportが担当します。

fetchletはtransportのFutureをInvocation内で直接pollします。Futureのwaker通知か、JSの次のtimer時刻でエンジンを起床させます。周期的なpoll待機時間は設けていません。

transportはstreaming本文を返せます（`Body::from_http_body`）。guestのfetchでは本文をJSのReadableStreamとして需要駆動で読み、`response_body_bytes` を宣言長と読み取りの累積で検査します。JS側のcancel・abort、Invocationの終了で本文をdropし、transportへcancelを伝えます。Rustから直接使う `FetchService::fetch` は本文を予算内で回収して返します。

## 本文とライフサイクル

公開型は `http::Request<Body>` / `http::Response<Body>`。`Body` は `http_body::Body` を実装し、buffer、workerからのstreaming、任意の `http_body::Body` を包んだstreaming（`Body::from_http_body`）を保持します。バイナリ本文と複数のSet-Cookieを維持します。JSとの転送はJSON messageと、Invocationのbyte storeを介したtyped arrayです。

Invocation終了時には所有するtransport Futureを同期的にdropします。通常の完了や、処理の残っていないJS例外の後はInstanceを再利用できます。Rust Futureの中断、期限切れ、未完了のhost fetchを残したreturnの後はInstanceを退役させます。`App::is_reusable()` で状態を確認でき、退役後の呼び出しは `InstanceUnavailable` を返します。

現profileでは呼び出し終了時に残ったtimerを破棄します。streaming本文はInvocationを保持するleaseで、本文完了・cancelまで実行環境を維持します。`fetchlet.waitUntil` で登録したbackground処理は、Invocationのhost scopeとtimerを保持したまま応答後に実行し、`background_timeout` と `background_tasks` の予算で制限します（[設計方針](design-proposal.md#streamingとbackground)）。

## 資源予算

`AppBuilder::limits(Limits)` で用途に応じた予算を指定します。各項目は `Option` で、`Some(value)` がその予算を有効にします。`None` は周囲のHTTPサーバやprocess supervisorに予算管理を委ねます。既定の `Limits` は全項目 `None` です。

本文、headers、URL、message、digest、subrequest、redirect、協調的期限を設定できます。エンジン固有のheap / stackは `QuickJsOptions`、V8 workerのstackは `V8Options` で指定します。詳細と根拠は[資源予算](resource-policy.md)にまとめています。

## 検証

`vp run test:host` は3エンジンで本物のJS fetchとmock transportを往復させます。通信権限、binary POST、Cookie、認証付与、redirect、rewrite、env、名前付きservice、abort、Instance退役を検査します。

結果は [host-matrix.json](../results/host-matrix.json)。実装は `crates/fetchlet/src/host/`、`crates/fetchlet/src/bridge/`、`crates/fetchlet/js/host-bridge.js`、runnerは `crates/fetchlet/tests/support/lab/` にあります。

`App::fetch_with_context(request, &context)` はentryの第二引数へSerde対応の呼び出し固有情報を渡します。SvelteKit adapterではclient addressに利用します。

## 共有実行とHTTP統合

AppBuilder::spawnはSend + SyncのAppHandleを返します。関数、Fetch、context付きFetchをclone間で共有でき、キュー容量を明示設定します。Futureのdropをキャンセルへ伝え、退役したInstanceは次の呼び出し前に再生成します。shutdownは新規受付を終了し、受付済み処理と資源回収を待ちます。詳細は[共有handle](../crates/fetchlet/README.md)、[axum統合](../crates/fetchlet-axum/README.md)を参照してください。
