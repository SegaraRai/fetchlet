# プロセス内fetchの設計案

2026-11-16。frameworkのserver-side JSからRustのhandler / routerを直接呼ぶ経路を整理します。現在の公開APIは[Host services](host-services.md)が基準です。以下のorigin登録、信頼できるContextの伝播、router統合は検討中の設計で、公開API名や型の確定は今後行います。

## 利用モデル

```text
Rustホスト → Request → framework server-side JS → Response → Rustホスト
                               ↓ fetch(Request)
                       宛先の分類と権限の検査
                               ↓
                      Rust handler / router
                               ↓ Response
                       frameworkの処理を継続
```

JS側はFetchのRequest / ResponseでRustのAPIを利用します。内部宛先はプロセス内で完結させ、外部宛先は別に構成したnetwork transportへ渡します。HTTPのlistenやsocketを内部呼び出しのために追加せず、Rustのアプリ状態を共有することを目標にします。

## 現在利用できる土台

| 現在のAPI・実装               | 実装済みの役割                                                              |
| ----------------------------- | --------------------------------------------------------------------------- |
| FetchTransport::send(Request) | SendのFutureでResponseまたはfetchlet::Errorを返す、single-hopの中立的な境界 |
| transport_fn                  | 非同期RustクロージャをFetchTransportへ接続                                  |
| FetchService                  | rewrite、宛先認可、credentials、redirectと資源予算                          |
| HostServices::outbound        | JSのglobal fetchが使うserviceを指定。渡すtransportはRust関数にもできる      |
| HostServices::service         | 名前付きserviceをJSのfetchlet.envから利用                                   |
| App::fetch_with_context       | JS entryの第二引数へ呼び出し固有のSerde値を渡す                             |
| Invocation                    | host Futureを所有し、終了時にdropして回収                                   |

coreのRequest / Responseはfetchlet::Bodyを使うhttp型です。coreはaxumやTowerへ依存せず、axum統合は任意のfetchlet-axumに分けています。

## 現APIによる最小例

[sveltekit-axum](../examples/sveltekit-axum/README.md#プロセス内のrust-api)は、現在のtransport_fnだけでRust APIをプロセス内から呼ぶ構成を示します。

- Rust側のProjectsApiはアプリ状態（プロジェクト一覧と呼び出し数）を保持し、Requestのmethodとpathで処理します。axumのnative route `/api/rust/stats` も同じ状態を読みます。
- 一つのFetchServiceを `HostServices::service("RUST", …)` と `HostServices::outbound(…)` の両方へ渡します。policyは `https://rust.fetchlet.test` だけを許可します。
- そのため `platform.env.RUST.fetch`、global fetch、SvelteKitの `event.fetch` による他origin宛てのfetchが、socketを使わずに同じRust関数へ届きます。

E2Eで次の結果を確認しています。

| 場面                                             | 確認した結果                                                                             |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| loadの `event.fetch`、actionの `RUST.fetch`      | Rustの状態を読み書きする。400はactionの `fail` へ、404はendpointのResponseへそのまま渡る |
| handlerが `Err(Error::Transport)` を返す         | fetchがcode `TRANSPORT` でreject。Rust側の詳細はmessageに含まれない                      |
| 許可外origin（binding / global / `event.fetch`） | すべてcode `PERMISSION_DENIED` でreject。Rust handlerは呼ばれない                        |
| AbortSignalで中断                                | fetchがrejectし、Rust handlerのFutureがdropされる                                        |
| 同一originの `event.fetch("/api/context")`       | SvelteKitがJS内で処理し、Rust handlerは呼ばれない                                        |

この構成では、宛先の判定はFetchPolicyのorigin許可と、transportに渡したRust関数のpath処理が担います。

共通のorigin登録表とrouter adapterは次の設計対象です。また、fetch_with_contextの値はJSへ渡す引数です。現在のFetchTransport::sendはRequestだけを受け取り、元のRust呼び出しの認証主体やtrace情報を自動で受け取る経路は備えていません。

実装の対応箇所は[transport](../crates/fetchlet/src/host/transport.rs)、[service](../crates/fetchlet/src/host/service.rs)、[bindings](../crates/fetchlet/src/host/bindings.rs)、[host bridge](../crates/fetchlet/src/bridge/dispatcher.rs)、[例のRust service](../examples/sveltekit-axum/src/services.rs)です。

## 中核となるhandler境界の候補

概念上は次の非同期境界を想定します。Contextは本書での設計上の呼び名で、現行の公開型ではありません。

```text
async (fetchlet::Request, Context) → fetchlet::Result<fetchlet::Response>
```

中核はクロージャや独自handlerを接続できる構造にし、有名なRust framework向けの変換は任意のadapterに置きます。axum / Tower等では、同じRust routerを通常HTTPの入口とプロセス内fetchの両方から呼べる形を検討します。socket接続時の情報やmiddlewareが期待する状態は、各入口のadapterで明示的に供給します。

既存のFetchTransportとFetchServiceの契約を足場に拡張します。固定したアプリ状態は現在と同様にRust側で保持し、呼び出しごとのContextを加える際は、Invocationからの伝播、所有権、Send要件、redirect先への公開範囲を設計します。

## origin登録と振り分けの候補

例えばhttps://rust.invalid/api/projectsを内部APIのURLとして使い、そのoriginをRust handlerへ明示登録する形を想定します。rust.invalidは説明用の名前です。実際のoriginはホストが選び、scheme / host / portを正規化して完全一致で登録・照合します。

振り分けでは次の契約を満たす案とします。

1. 内部originに一致するRequestは、登録したRust handlerで完結する。
2. handlerが返す404や500も、その内部APIのHTTP ResponseとしてJSへ返す。
3. handlerの実行エラーや未処理を外部networkへ自動fallbackさせる経路は設けず、明示したResponseまたはエラーへ変換する。
4. 外部fetchは、別途許可した宛先とnetwork transportを使う。
5. trusted rewriteがある場合は、書き換え後の宛先を分類・認可し、credentialsを最終宛先へ結び付ける。
6. redirectの各hopで宛先分類と権限を再評価する。内部から外部へ進む経路も明示的な許可の対象にする。

現在のFetchServiceが持つrewrite → 認可 → credentials → single-hop実行の意味を維持します。origin登録を実装する際に、この処理と振り分けの責任分担を確定します。内部向け404等からnetworkへのfallbackを防ぐ試験を、実装時の受け入れ条件に含めます。

## frameworkとブラウザーのURL

frameworkが提供するfetchとfetchletの責任分担は次のとおりです。SvelteKitの `event.fetch` で確認済みです。

- 同一originの相対URL・絶対URLは、frameworkが自身のrouteとしてJS内で処理します。fetchletのhost fetchは使いません。
- 他originのURLはframeworkがglobal fetchへ渡し、fetchletの `HostServices::outbound` のpolicyとtransportが処理します。frameworkが付けるheaders（cookieの転送規則等）はframeworkの仕様に従います。
- `platform.env.RUST` 等の名前付きbindingは、frameworkを経由せずに直接fetchletのserviceを呼びます。

他frameworkの内部fetchも、adapterごとに同じ観点で確認します。

内部originはserver-side JS用の宛先識別です。ブラウザーからのfetchは、公開HTTPの同じRust routerや、ホストが別途提供する接続経路を使います。例えばserver-side JSはhttps://rust.invalid/api/projects、ブラウザーは公開origin上の/api/projectsを使い、両方を同じRust handlerへつなぐ構成が候補になります。ブラウザー向けには公開URLだけを渡します。

[Tauri連携](embedded-applications.md#tauriとの関係)でも、WebViewのorigin、protocol、権限とブラウザー側の通信経路を個別に検証します。server-side JSの内部URLと、WebViewから到達するURLを各adapterで対応付けます。

## 信頼できるContextとheaders

認証主体、権限、tenant、traceの起点等はRustが作るContextとして扱い、JSが編集できるRequest headersと分けます。JSへ渡すSerde値は必要な情報のprojectionとして選び、Rust handlerへ渡す信頼情報はRust側のInvocationに保持する案です。

内部APIのhandlerやmiddlewareが認可に使う情報は、この信頼できる経路から供給します。headersから認証情報を採用する構成では、通常HTTPと同じ検証を行います。JSから指定したidentity用headerでRustの認証主体を上書きできる構成を避けます。

Request extensionsやtask-localだけに依存せず、JSとのwire変換、redirect、worker、将来のpoolを通した伝播を定義します。現在のwire表現はURL・method・header pairs・本文で、Rust固有のextensionsは転送しません。Contextの伝播と、redirect用Requestの再生成も合わせて設計します。

## cancel、本文とエラー

AbortSignal、Rust Futureのdrop、呼び出し期限を結び付け、内部handlerの処理もInvocationが回収できる形にします。現在のhost fetchはticketとInvocationの所有Futureでcancelを扱います。キャンセル契約は接続先のRust handlerにも適用します。

本文はJSとRustのBody間を読み取り需要に応じてstreamingし、本文の完了・cancelまでInvocation / Instanceのleaseを維持します。内部serviceの本文も同じ所有権、資源予算、切断時の回収に従います（[streaming設計](design-proposal.md#streamingとbackground)）。

HTTPエラーと実行エラーは、JSから見える結果を分けます。

| Rust側の結果                                       | JS側の扱い                                                    |
| -------------------------------------------------- | ------------------------------------------------------------- |
| 正常なHTTP Response。statusが404 / 500の場合も含む | fetchのPromiseをResponseで解決                                |
| 権限拒否、実行・通信エラー、cancel等               | fetchのPromiseをreject。安定したcodeと一般化したmessageを提供 |

現行bridgeもHTTP statusとRustのResultエラーをこの形で扱います。origin振り分けやframework統合を加える際も、この区別を維持します。

## 再入と待ち合わせ

現在のApp / AppHandleは一つのInstanceを直列実行します。そのJSが内部fetchでRust routerを呼び、routerが同じAppHandleへ再び依頼すると、処理待ちの循環が起きます。

同じrouterの再利用は、API routeとJS render routeの境界、再入の検出、再帰の予算と合わせて設計します。poolを使う場合も容量の枯渇による循環を評価します。再入の拒否、別Instanceへの割り当て、循環を作らないroute構成のうち、どれを公開するかは今後の設計判断です。

## 検証する順序

1. Request / Response、Body状態、Blob / multipartの適合性を整え、関連WPTと回帰試験を増やす。
2. origin登録と信頼できるContextの契約を確定し、未登録・失敗・redirect時の宛先と権限を試験する（transport_fnによる最小例でorigin policy、HTTPエラー、実行エラー、cancel、`event.fetch` の分担は確認済み）。
3. 任意のRust router adapterで、同じAPIを通常HTTPとプロセス内fetchから呼ぶE2Eを加える。
4. artifactとassetsの埋め込み、CLI等の起動・終了、Tauriの読み込み経路を順に実測する。

この順序は開発候補です。具体的な公開API、Rust frameworkごとの対応範囲、Tauri統合の成立は、各実装と試験で確定します。
