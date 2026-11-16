# fetchlet-hyper

hyper 1の接続で[fetchlet-tower](../fetchlet-tower/README.md)のserviceを使うための薄い層です。hyperのservice traitを実装し、接続ごとのpeer addressをrequestへ記録します。受信・本文予算・context・エラーの振る舞いはfetchlet-towerと同じです。

```rust,ignore
use hyper::server::conn::http1;
use hyper_util::rt::TokioIo;
use fetchlet_hyper::FetchletService;

let service = FetchletService::new(app.clone(), "https://example.test")?
    .on_error(|error| eprintln!("{error:#}"));
loop {
    let (stream, peer) = listener.accept().await?;
    let connection = service.connection(peer);
    tokio::spawn(http1::Builder::new().serve_connection(TokioIo::new(stream), connection));
}
```

- `FetchletService::connection(peer)` は、その接続のrequestへ `PeerAddr` を入れるhyper serviceを返します。既定のcontextのclientAddressはこの値です。`peer_addr(parts)` は `trusted_context` 等で同じ値を読むための関数です。
- `FetchletService` 自体もhyperのservice traitを実装します。peer addressを持たない接続に使います。
- `context`、`trusted_context`、`on_error`、`stream_request_bodies` はfetchlet-towerの同名メソッドと同じです。`into_inner()` でTower serviceを取り出せます。
- 応答は `http::Response<fetchlet::Body>` で、本文はstreamのままhyperへ渡ります。
- クライアントの切断でhyperがservice futureをdropすると、Invocationとそのhost fetchもcancelされます。
- `Error`、`RequestContext`、`service_transport` はfetchlet-towerを再公開しています。

hyper-utilの `TowerToHyperService` でfetchlet-towerのserviceを直接使うこともできます。その場合は接続情報をrequest extensionsへ入れ、`client_address` で読み出し方を指定します。

## 試験

[共通契約](../../tests/http-integrations/contract.rs)を `tests/contract.rs` で、loopbackの実TCP接続に対して実行します。hyperのclientがContent-Lengthの宣言とchunked送信を行い、クライアント切断によるcancelも実接続で確認します。HTTP/1.1では本文の送信に失敗したクライアントは接続を中断して応答を受け取らないため、その項目はサーバ側の処理と続くrequestを確認します。Cargo featureはquickjs（既定）、boa、v8です。
