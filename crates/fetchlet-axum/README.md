# fetchlet-axum

axumのRequestを共有AppHandleへ渡し、fetchletのResponseをaxumへ返すServiceです。framework adapterと独立して利用できます。

```rust,ignore
use axum::Router;
use fetchlet_axum::FetchletService;

let rendering = FetchletService::new(app.clone(), "https://example.test")?
    .on_error(|error| eprintln!("{error:#}"));
let router = Router::new().fallback_service(rendering);
```

公開originは設定から指定します。入力のpath / query / method / headersを保持し、本文はAppのrequest_body_bytes予算で読み取ります。binaryと複数のSet-Cookieを保持します。

default contextはConnectInfo<SocketAddr>から得たclientAddressです。axumのinto_make_service_with_connect_infoを使用すると接続情報が届きます。context callbackでHTTP request partsから任意のSerde対応値を作ることもできます。

fetchメソッドは詳細なRust Errorを返します。Serviceとして使う場合は一般化したHTTPエラー応答を返し、on_error callbackへ詳細を渡します。workerの終了は503、期限切れは504、受信本文の超過は413として扱います。

Cargo featureはquickjs（既定）、boa、v8。使うbackendのfeatureを有効にします。例はexamples/sveltekit-axumとexamples/astro-axum、回帰試験はtests/service.rsにあります。
