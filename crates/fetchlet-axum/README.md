# fetchlet-axum

axumのRequestを共有AppHandleへ渡し、fetchletのResponseをaxumへ返すServiceです。framework adapterと独立して利用できます。

```rust,ignore
use axum::Router;
use fetchlet_axum::FetchletService;

let rendering = FetchletService::new(app.clone(), "https://example.test")?
    .on_error(|error| eprintln!("{error:#}"));
let router = Router::new().fallback_service(rendering);
```

公開originは設定から指定します。入力のpath / query / method / headersを保持し、本文は既定でAppのrequest_body_bytes予算の範囲で回収してからhandlerへ渡します。`stream_request_bodies()` を指定すると本文をhandlerのReadableStreamとして渡し、handlerは受信完了を待たずに開始します。この場合も宣言されたContent-Lengthの超過は実行前に413とし、宣言のない超過と受信本文の失敗はhandlerの本文streamのエラー（`LIMIT_EXCEEDED` / `TRANSPORT`）となって、応答はhandlerが決めます。binaryと複数のSet-Cookieを保持します。

default contextはConnectInfo<SocketAddr>から得たclientAddressです。axumのinto_make_service_with_connect_infoを使用すると接続情報が届きます。context callbackでHTTP request partsから任意のSerde対応値を作ることもできます。

`trusted_context` callbackはrequest partsから `fetchlet::Context` を作ります。ContextはJSへ渡らず、host fetchがinternal routeへ届けます。認証主体や接続元のように、JSが設定できるheadersで代用してはいけない値に使います。

`router_transport(router)` はaxumの `Router` や任意のTower serviceを `fetchlet::FetchTransport` にします。`OriginRouter::internal` へ登録すると、同じrouterを公開HTTPとJSからのプロセス内fetchで共用できます。handlerは `Option<Extension<fetchlet::Context>>` でContextを読み、応答本文はstreamとしてJSへ返ります。

fetchメソッドは詳細なRust Errorを返します。Serviceとして使う場合は一般化したHTTPエラー応答を返し、on_error callbackへ詳細を渡します。workerの終了は503、期限切れは504、受信本文の超過は413として扱います。

Cargo featureはquickjs（既定）、boa、v8。使うbackendのfeatureを有効にします。例はexamples/sveltekit-axumとexamples/astro-axum、回帰試験はtests/service.rsとtests/router.rsにあります。
