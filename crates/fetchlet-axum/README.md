# fetchlet-axum

axumで[fetchlet-tower](../fetchlet-tower/README.md)のTower serviceを使うための薄い層です。受信・本文予算・context・エラーの振る舞いはfetchlet-towerと同じで、このcrateはaxumの型と接続情報を接続します。

```rust,ignore
use axum::Router;
use fetchlet_axum::FetchletService;

let rendering = FetchletService::new(app.clone(), "https://example.test")?
    .on_error(|error| eprintln!("{error:#}"));
let router = Router::new().fallback_service(rendering);
```

- `FetchletService` はaxumの `Request` を受け、axumの `Response` を返します。既定のcontextのclientAddressは `ConnectInfo<SocketAddr>` から読みます（`into_make_service_with_connect_info` を使います）。`connect_info(parts)` は `trusted_context` 等で同じ値を読むための関数です。
- `context`、`trusted_context`、`on_error`、`stream_request_bodies`、`fetch` はfetchlet-towerの同名メソッドと同じです。`into_inner()` でTower serviceを取り出せます。
- `router_transport(router)` は `service_transport` のaxum `Router` 版です。`OriginRouter::internal` へ登録すると、同じrouterを公開HTTPとJSからのプロセス内fetchで共用できます。handlerは `Option<Extension<fetchlet::Context>>` でContextを読みます。
- `Error`、`RequestContext`、`service_transport` はfetchlet-towerを再公開しています。

axumはfetchlet-towerのserviceを直接受け付けるため（`http::Response<fetchlet::Body>` は `IntoResponse` を満たします）、このcrateを使わずにfetchlet-towerを `fallback_service` へ渡すこともできます。その場合は `client_address(fetchlet_axum::connect_info)` 相当の指定が必要です。

Cargo featureはquickjs（既定）、boa、v8です。[共通契約](../../tests/http-integrations/contract.rs)を `tests/contract.rs`、routerの共用を `tests/router.rs` で確認します。例はexamples/sveltekit-axumとexamples/astro-axumです。
