# fetchlet-actix

actix-web 4で共有AppHandleを使うhandlerです。actix-webは `http` 0.2系の型と独自のService traitを使い、handlerのFutureは `Send` ではないため、Tower serviceとは別に変換を実装しています。

```rust,ignore
use actix_web::{App, HttpServer};
use fetchlet_actix::FetchletService;

let fetchlet = FetchletService::new(app.clone(), "https://example.test")?
    .on_error(|error| eprintln!("{error:#}"));
HttpServer::new(move || App::new().default_service(fetchlet.clone().route()))
    .bind(("127.0.0.1", 8080))?
    .run()
    .await?;
```

## 振る舞い

- method、path / query、headersを `http` 1系へ変換し、公開originを適用します。既定のcontextのclientAddressは `HttpRequest::peer_addr` です。
- payloadは既定で `request_body_bytes` 予算内で回収します。宣言されたContent-Lengthの超過と回収中の超過は413、payloadの失敗は400です。
- `stream_request_bodies()` では、actixのthreadで動くlocal taskがpayloadを読み、容量1のchannelでworkerへ渡します。読み取りは需要に応じて進み、本文がdropされるとtaskも終了します。宣言されたContent-Lengthの超過は実行前に413、宣言のない超過とpayloadの失敗はhandlerの本文streamのエラーです。
- 応答は複数のSet-Cookieを含むheadersを保持し、本文をstreamで返します。長さが分かる本文はContent-Lengthを付けます。framingのheaders（content-length / transfer-encoding / connection）はactixが本文から決めます。
- `context(|request| ...)`、`trusted_context(|request| ...)`、`on_error` はfetchlet-towerと同じ役割で、`&HttpRequest` を受け取ります。エラー応答の対応表はfetchlet-towerの `Error` を共有します。
- 接続の切断等でhandlerのFutureがdropされると、Invocationもcancelされます。

## 範囲

JSからactix-webのアプリをプロセス内で呼ぶtransportはまだありません。actixのserviceは `Send` ではないため、専用のactixランタイムのthreadとchannelで接続する設計が必要です。プロセス内APIは、`fetchlet::transport_fn` のRust関数か、fetchlet-towerの `service_transport` で構成できます。

## 試験

[共通契約](../../tests/http-integrations/contract.rs)を `tests/contract.rs` でactix-webのtest serviceに対して実行します。chunkedのpayloadと失敗するpayloadも含めて、fetchlet-towerと同じ項目を3エンジンで確認します。Cargo featureはquickjs（既定）、boa、v8です。
