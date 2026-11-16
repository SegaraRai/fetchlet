# 設計と拡張計画

2026-11-16。現在の構造と、それを発展させる方針を示します。現APIの使い方は[Host services](host-services.md)を参照してください。

## 現在の構造

```text
Rust HTTPサーバ / 関数の呼び出し元
    ↓ App.fetch / App.call / App.call_json
App: module + fixed bindings + caller budgets
    ↓ Invocation: cancellation + owned host futures
Instance: backendの実行状態
    ├─ Web API profile / Fetch adapter / 任意関数
    └─ host bridge → Rust services / fetch / crypto
```

| 要素             | 現在の責務                                           |
| ---------------- | ---------------------------------------------------- |
| Module           | ビルド済みソースと入口情報                           |
| App / AppBuilder | backend、module、固定binding、Limitsの構成と呼び出し |
| Instance         | 任意関数の呼び出し、JSONの入出力、再利用状態         |
| InvocationScope  | 呼び出し世代、host Future、終了時の回収              |
| HostServices     | 明示的env、外向きfetch、名前付きservice              |
| FetchService     | rewrite、origin認可、認証付与、redirect制御          |
| FetchTransport   | Rust側のsingle-hop非同期処理                         |
| Body / wire      | http型とJSのバイト・header pair表現の変換            |

公開入口はrootから `pub use` し、内部は `app/`、`backend/`、`bridge/`、`config/`、`execution/`、`fetch/`、`host/`、`wire/` に分けます。各 `mod.rs` と `lib.rs` は宣言・再公開を担当します。engine固有コードは `backend/<engine>/`、framework runnerは `tests/support/` に置きます。

## 関数実行とFetch

最小の土台は名前付き関数の呼び出しです。`App::call` はSerdeの単一引数と戻り値、`call_json` はJSONの複数引数を扱います。現在の値境界はJSON互換値です。JS固有のhandleやhost resourceは、所有権と有効期間を持つ別の境界へ拡張します。

主経路のFetch adapterは `http::Request<Body>` と `http::Response<Body>` を扱います。JS側はWeb Request / Responseを使います。バイナリ本文と複数のSet-Cookieを保持し、HTTP接続とlistenはRustアプリが担当します。

TS / TSX / Svelteの変換と依存解決はbuild toolingへ集約します。ビルド済みartifactはbackend、profile、要求APIと選択したpolyfillを記録します。ABI版とRust側の能力照合をさらに統合します。Honoは薄いFetch entry、SvelteKitは専用adapterとplatform integrationを整備します。

## Appの寿命と並列性

Appは所有スレッド上で直接、AppHandleは共有handleから呼び出します。どちらも一つのInstanceを直列実行し、短期生成と長期保持を選べます。AppHandleがスレッド配置とキュー、キャンセルとInstance再生成を管理します。

poolは次の層として追加します。コンパイルcacheのキーはコード・backend版・profile等、実行環境の再利用キーはアプリ・テナント・binding・権限構成とします。共有Rust handleでも、Instanceの所有スレッドと再利用境界を維持します。

同一Instance内の並列呼び出しはtaskごとの文脈伝播を備える段階で導入します。固定bindingはApp単位、リクエスト固有の情報はInvocationの資源として扱います。

## Rust経由のfetch

JS fetchからRust async serviceへ接続し、全backendで同じpolicyを適用します。rewrite → 認可 → credentials → single-hop transportの順序を保ちます。redirectごとに宛先を認可し、秘密の寿命を送信単位にします。

transportは実HTTP client、内部Rust service、mockを交換できる境界です。現在のFetchTransport::sendはRequestを受け取り、transport_fnで非同期クロージャを接続できます。origin別の登録と、信頼できるRust Contextの呼び出しごとの伝播は拡張候補です。[プロセス内fetch](in-process-fetch.md)に、既存APIとの対応、宛先・権限・エラー・cancel・再入の契約案をまとめています。

実HTTP adapterではDNSと接続先IP、受信中の容量、Future dropによる中断を一緒に実装します。内部serviceは直接bindingできます。SvelteKit自身が処理する内部fetchと外向き通信はadapterで区別します。自己Appへの再入はpool待ちと再帰の方針を合わせて設計します。

host FutureはInvocationが直接所有します。waker通知と次のJS timer時刻でengineを駆動し、実行期限はAppの一か所で管理します。呼び出し側は[資源予算](resource-policy.md)を選択します。

## streamingとbackground

現在のBodyはbuffer方式で `http_body::Body` を実装します。双方向streamingへ進める際は次の所有関係を採用します。

```text
Rust Request Body → bounded queue → JS ReadableStream
JS Response body → bounded queue → Rust Response Body
                         ↓
             Invocation / Instance lease
```

キュー容量は構成可能にし、読み取り需要に応じて生成側を駆動します。Response Bodyがleaseを保持し、本文完了・cancelまでInstanceを維持します。Rust Bodyのdropと接続切断は、JS stream cancelとhost I/Oへ伝播します。

background処理はwaitUntil相当の明示的登録を検討します。呼び出しごとの期限と件数予算を設け、本文とbackgroundの両方が終了した時点でInstanceを再利用します。現profileのtimerは呼び出し終了時に回収します。

## backend能力と強制力

最小の関数実行と、Fetch、Promise、streaming、hard interrupt等の拡張能力を分けます。要求する能力とbackendの提供範囲を構成時に照合するAPIを追加する計画です。能力の異なるbackendは、その能力の範囲で利用できる形にします。

Web APIの実装には既存ライブラリ、共通profile、backend固有実装を使えます。build toolingはアプリが要求するAPIとbackend能力表を照合し、不足するpolyfillと依存データだけを組み込みます。IntlはFormatJSを使ってこの選択を実装し、localeとtimezone packはアプリの構成に従います。共通にするものは、外向きI/Oの制御点、権限の意味、資源所有権、適合テストです。

強制的なCPU / heap管理、初期化の打ち切り、process実行はbackendごとに設計します。第三者コードにはprocess / OS sandbox等を含む隔離が必要です。エラーは権限拒否、期限、資源超過、backend停止などの意味をRust側へ伝えます。

AOTはnative artifactのABI、compiler / runtime版、初期化・解放、値の型、公開関数、非同期能力を明示して接続します。まず確認できた同期関数境界を足場に、文字列・バイト列・例外・Promise・Fetchへ広げます。

## 次の実装

1. Request / Response、Blob / multipart等の適合性を既存実装の評価とWPT・回帰試験で整え、backend能力と構成要求の照合を広げる。
2. Bodyのlease、backpressure、双方向streamingとcancel伝播を実装する。
3. backendごとの強制力とprocess境界を整備し、poolの再利用条件を検証する。
4. framework adapterとRustの内部fetchを接続し、origin登録、信頼できるContext、任意のrouter統合と再入の契約を検証する。
5. AOTのRustリンクとABIを継続検証し、利用できる能力からAppへ接続する。

## 配布とホストアプリへの統合

単一のRust配布物でJS frameworkのサーバー側処理を提供する用途を重視します。CLI付属UI、ローカルツール、セルフホスト、Tauri連携の候補を[組み込みアプリ](embedded-applications.md)に整理しています。artifactと静的ファイルの埋め込み、初期化、初回表示、cancel、終了をホストのlifecycleへつなぎます。現在の例はbuildディレクトリを読み、埋め込み配布とTauriの実行経路は今後の統合対象です。

## Workspaceと例

Rust本体は `crates/fetchlet/`、共通JS支援とframework adapterは `packages/`、実アプリとE2Eは `examples/` に置きます。最初のSvelteKit + axum例から、frameworkとRust HTTPサーバを独立して追加する構成を育てます。[追加方針](../examples/README.md)を参照してください。

共有実行はAppHandle、axumのHTTP接続はfetchlet-axumへ実装しました。SvelteKitとAstroは@fetchlet/buildのartifact形式を共有し、同じRust integrationで動作します。次は追加のframeworkとstreaming等の能力を、この境界の上に拡張します。
