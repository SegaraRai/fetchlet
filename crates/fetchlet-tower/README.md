# fetchlet-tower

共有AppHandleを、`http` 1系の型を使うTower serviceとして公開します。hyperの接続（[fetchlet-hyper](../fetchlet-hyper/README.md)）、axumのrouter等、Towerと `http` 1系を扱うサーバでそのまま利用できます。framework adapterとは独立しています。

```rust,ignore
use fetchlet_tower::FetchletService;

let service = FetchletService::new(app.clone(), "https://example.test")?
    .client_address(|parts| parts.extensions.get::<SocketAddr>().map(SocketAddr::ip))
    .on_error(|error| eprintln!("{error:#}"));
// service: Service<http::Request<B>, Response = http::Response<fetchlet::Body>>
```

## 受信

- `FetchletService` は `http::Request<B>`（`B: http_body::Body<Data = Bytes>`）を受け、`http::Response<fetchlet::Body>` を返します。エラー型は `Infallible` で、失敗は一般化したHTTP応答になります。
- 公開originは設定値を使い、受信したpath / query / method / headersを保持します。
- 本文は既定でAppの `request_body_bytes` 予算内で回収してからhandlerへ渡します。超過は413、受信本文の失敗は400です。
- `stream_request_bodies()` を指定すると本文をhandlerのReadableStreamとして渡します。宣言されたContent-Lengthの超過は実行前に413、宣言のない超過と受信本文の失敗はhandlerの本文streamのエラー（`LIMIT_EXCEEDED` / `TRANSPORT`）です。
- binaryと複数のSet-Cookieを保持し、応答本文はstreamのまま返ります。

## context

- 既定のcontext（Fetch entryの第二引数）は `RequestContext { clientAddress }` です。接続情報はサーバごとにrequest extensionsの型が異なるため、`client_address(|parts| ...)` で読み出し方を指定します。
- `context(|parts| ...)` は既定のcontextを任意のSerde値に置き換えます。
- `trusted_context(|parts| ...)` は `fetchlet::Context` を作ります。ContextはJSへ渡らず、host fetchが `OriginRouter::internal` のrouteへ届けます。

## プロセス内transport

`service_transport(service)` は任意のTower serviceを `fetchlet::FetchTransport` にします。axumの `Router` もそのまま渡せます。`OriginRouter::internal` へ登録すると、同じserviceを公開HTTPとJSからのプロセス内fetchで共用できます。Requestはextensionsを保持し、serviceのエラーはJSのfetchを一般化したtransportエラーでrejectします。

## エラー

`fetch` は詳細な `Error` を返します。Serviceとしての呼び出しは `on_error` へ詳細を渡し、一般化した応答を返します。workerの終了・利用不可は503、期限切れは504、受信本文の超過は413、URL超過は414、権限拒否は403です。`Error`、`PublicOrigin`、`RequestContext` はfetchlet-hyper / fetchlet-axum / fetchlet-actixと共有します。

## 試験

[共通契約](../../tests/http-integrations/contract.rs)を `tests/contract.rs` で実行します。公開origin、headers、binary、複数のSet-Cookie、接続元、context、回収・streaming本文の予算と失敗、エラー詳細の分離とworker終了、信頼できるContext、切断によるcancelを3エンジンで確認します。Cargo featureはquickjs（既定）、boa、v8です。
