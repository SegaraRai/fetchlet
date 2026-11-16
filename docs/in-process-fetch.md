# プロセス内fetch

frameworkのserver-side JSから、Rustのhandler / routerをHTTP接続なしで呼ぶ経路です。宛先の振り分け、信頼できるContext、axum routerの再利用、再入の検出を実装しています。公開APIの基準は[Host services](host-services.md)です。

## 利用モデル

```text
Rustホスト ─ Request + Context ─→ framework server-side JS
                                        │ fetch(Request)
                                        ▼
                         FetchService（rewrite → 認可 → credentials）
                                        │
                              OriginRouter（originの完全一致）
                       ┌────────────────┴────────────────┐
                 internal route                      external route
          Rust handler / axum router            network client等
            （Contextを受け取る）                （Contextを渡さない）
```

JSはFetchのRequest / ResponseでRust APIを使います。内部宛先はプロセス内で完結し、Rustのアプリ状態を共有します。外部宛先は別に登録したtransportへ渡します。

## 構成するAPI

| API                                 | 役割                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `FetchTransport` / `transport_fn`   | single-hopの非同期境界。Rust関数を接続する。`Arc<T>` も共有transportとして使える |
| `OriginRouter::internal(origin, t)` | originをtrusted transportへ登録する。Contextを受け取る                           |
| `OriginRouter::external(origin, t)` | originをtransportへ登録する。Contextは取り除く                                   |
| `OriginRouter::into_service()`      | 登録したoriginだけを許可するFetchServiceを作る                                   |
| `Context`                           | Rustが作る型付きの値の集合。`App::fetch` へ渡すRequestのextensionsに入れる       |
| `FetchService::forward_context()`   | 単一transportのserviceでContextを渡す。指定しないserviceはContextを取り除く      |
| `fetchlet_tower::service_transport` | 任意のTower serviceをtransportにする                                             |
| `fetchlet_axum::router_transport`   | axumの `Router` をtransportにする                                                |
| `FetchletService::trusted_context`  | 受信requestからContextを作る（fetchlet-tower / axum / actix）                    |

```rust,ignore
let service = OriginRouter::new()
    .internal("https://api.internal", router_transport(api_router(state.clone())))?
    .external("https://api.example.com", network_client)?
    .into_service();
let services = HostServices::new()
    .outbound(service.clone())
    .service("API", service);
```

## 宛先の振り分け

`OriginRouter` はscheme / host / portを正規化したoriginの完全一致で振り分けます。

1. 登録したoriginのRequestは、そのtransportだけが処理します。
2. transportが返す404や500は、その内部APIのHTTP ResponseとしてJSへ届きます。
3. 未登録のoriginはpolicyで `PERMISSION_DENIED` となり、どのtransportも呼びません。別のrouteやnetworkへのfallbackはありません。
4. rewriteの後の宛先を分類・認可し、credentialsは最終宛先へ結び付けます。
5. redirectの各hopで分類と認可をやり直します。内部から外部へのredirectは、外部originを登録した場合に限り進み、そのhopにContextは渡りません。

同じoriginの重複登録、pathやqueryを含むoriginは構成エラーです。

## 信頼できるContext

認証主体、tenant、traceの起点等は `Context` としてRustが作ります。

- `App::fetch` / `AppHandle::fetch` に渡すRequestのextensionsに `Context` を入れると、そのInvocationが保持します。JSへ渡すwire requestには含まれません。
- そのInvocationのhost fetchは、Contextのcloneをrequest extensionsに載せます。internal routeと `forward_context()` を指定したserviceだけが受け取ります。
- JSはContextを読めず、作れず、置き換えられません。request headersからContextが作られることもありません。
- fetchlet-tower / fetchlet-hyper / fetchlet-axum / fetchlet-actixでは `FetchletService::trusted_context` でConnectInfoや認証middlewareの結果からContextを作り、axum handlerは `Option<Extension<fetchlet::Context>>` で読みます。
- 各hopのRequestはextensionsを引き継ぐため、internal route間のredirectでもContextが届きます。

`App::fetch_with_context` のSerde値はJS entryの第二引数で、Contextとは別の、JSに見せるための値です。

## axum routerの再利用

`router_transport(router)` は、同じaxum routerを公開HTTPとプロセス内fetchの両方から使えるようにします。

- method、絶対URI、headers、本文、extensionsをそのまま渡します。routerはpathで処理します。
- 応答本文はstreamとしてJSへ返り、`response_body_bytes` の予算で読み取ります。
- fetchのabortやInvocationの終了でhandlerのFutureをdropします。
- プロセス内のRequestには `ConnectInfo` 等の接続情報がありません。必要な値はContextで渡します。

## cancel、本文とエラー

AbortSignal、host Futureのdrop、呼び出し期限は結び付いています。abortするとhandlerのFutureはInvocationの終了を待たずにdropされます。本文は需要に応じてstreamingし、本文の完了・cancelまでInvocationのleaseを維持します（[streaming設計](design-proposal.md#streamingとbackground)）。

| Rust側の結果                                 | JS側の扱い                                                    |
| -------------------------------------------- | ------------------------------------------------------------- |
| HTTP Response。statusが404 / 500の場合も含む | fetchのPromiseをResponseで解決                                |
| 権限拒否、transportの `Err`、cancel、再入等  | fetchのPromiseをreject。安定したcodeと一般化したmessageを提供 |

## 再入

`AppHandle` は一つのInstanceで直列に実行します。host fetchの処理中に同じ `AppHandle` を呼ぶと、その呼び出しは自身の完了を待つことになります。

- workerはhost Futureをpollする間、そのアプリの識別子をthread-localに記録します。その間に同じアプリへ依頼すると、`AppHandle` は即座に `Error::Reentrant`（JSではcode `REENTRANT`）を返します。workerが作り直すInstanceも同じ識別子を使います。
- 別のアプリの `AppHandle` への依頼は通常どおり実行します。
- 検出の対象は、host Futureのpoll内で直接行う依頼です。handlerが `tokio::spawn` した別taskから同じアプリを呼んで結果を待つ構成は検出できず、呼び出し期限（`Limits::timeout`）まで待ちます。

## frameworkの内部fetchとの分担

SvelteKitの `event.fetch` で次の分担を確認しています。

- 同一originの相対URL・絶対URLは、frameworkが自身のrouteとしてJS内で処理します。fetchletのhost fetchは使いません。
- 他originのURLはframeworkがglobal fetchへ渡し、`HostServices::outbound` のserviceが処理します。frameworkが付けるheaders（cookieの転送規則等）はframeworkの仕様に従います。
- `platform.env.RUST` 等の名前付きbindingは、frameworkを経由せずにserviceを呼びます。

内部originはserver-side JS用の宛先識別です。ブラウザーには公開origin上のURL（例では `/api/v1`）を渡し、同じrouterへつなぎます。[Tauri連携](embedded-applications.md#tauriとの関係)では、WebViewのorigin、protocol、権限をadapterごとに対応付けます。

## 検証

| 範囲                                       | 試験                                                                                |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| Contextの付与・除去、originの完全一致      | `crates/fetchlet/src/host/tests.rs`                                                 |
| 3エンジンでのContext、redirect、拒否、再入 | `crates/fetchlet/tests/in_process.rs`                                               |
| axum routerの共用、`trusted_context`       | `crates/fetchlet-axum/tests/router.rs`、各HTTP統合の`tests/contract.rs`             |
| SvelteKitでのE2E                           | [sveltekit-axum](../examples/sveltekit-axum/README.md#プロセス内のrust-api)の16項目 |

例のE2Eは、同じrouterの公開HTTPとプロセス内fetch、400 / 404 / 500のResponse、Contextによる呼び出し元、許可外originの拒否、abortによるhandlerのdrop、`event.fetch` の分担を確認します。

## 次の作業

1. 汎用関数呼び出し（`App::call` 等）にもContextを渡す入口を設ける。
2. pool導入時の再入（容量の枯渇による待ち合わせ）と、spawnしたtaskからの再入の扱いを決める。
3. Astro等、他frameworkの内部fetchの分担をadapterごとに確認する。
4. artifactとassetsの埋め込み、CLI等の起動・終了、Tauriの読み込み経路を順に実測する。
