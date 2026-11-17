# fetchletのコンセプトと方針

2026-11-16。プロジェクトの合意事項をまとめます。現在のAPIは[Host services](host-services.md)、実測は[実装・検証状況](implementation-status.md)を参照してください。

## 目的

RustでサーバーサイドJavaScriptをeasyかつsecureに実行する。主用途は、Hono JSX、SvelteKit、Astroなどのサーバー側処理をRustアプリへ組み込み、リッチなWeb UIを提供することです。特にCLI付属UI、ローカルツール、セルフホストアプリのように、単一のRust配布物へまとめたい用途を重視します。HTML / JSON生成、Rust APIの集約、アプリ内の変換関数にも同じ土台を活用します。

easyは、選べるバックエンドでのJS実行、Web API、Request / Response変換、env、外向きfetchとRustサービスの接続を扱いやすいAPIにまとめることです。backendの能力に応じて不足するpolyfillと依存データだけを組み込み、既存のnative APIを活かします。secureは、権限・所有権・隔離・資源管理を設計し、多数のテストとfuzzingで継続的に検証することです。

## 配布とアプリ資産の共有

Rust配布物にJS frameworkのデータ取得、フォーム、動的描画を含め、Web版、CLI付属UI、Tauri連携でページとアプリ処理を共有しやすくすることを目指します。SPA / SSGの静的ファイル埋め込みも単一バイナリの選択肢です。fetchletは、実行時のserver-side JSとRustの機能を一緒に扱う用途へ価値を置きます。

現在の例はbundleとassetsをbuildディレクトリから読みます。埋め込み配布とTauri連携は次の検証対象です。起動時間、配布サイズ、RSS、初回表示を同じアプリで測定します。[用途・配布・Tauriの整理](embedded-applications.md)に詳細をまとめます。

## 基本の利用モデル

```text
Rust HTTPサーバ / アプリケーション
    → Requestを合成または受信
    → JSのFetchハンドラを実行
    → Responseを回収
    → Rustがクライアントへ送信
```

JSからRustへは、fetch(Request)をプロセス内のRust handler / routerへ渡す対称な経路を育てます。FetchTransport / transport_fn、名前付きservice、originで振り分ける `OriginRouter`、Rustが作る信頼できる `Context`、axum routerを使う `router_transport` で構成します（[プロセス内fetch](in-process-fetch.md)）。

Request → Responseを主経路とし、名前を指定した任意の同期・非同期関数を呼び出すAPIも維持します。TS / TSX / Svelteはビルド時にJavaScriptへ変換します。

プロジェクト名はfetchlet、作業場所は `F:\Projects\fetchlet` です。バックエンドを選択でき、軽量な構成を重視します。QuickJS、Boa、V8を検証し、experimentalなAOTも維持します。軽量さは同一アプリで配布サイズ、起動時間、RSS、処理時間を測って評価します。

## 実行環境と権限

寿命、隔離、権限、互換性を独立した設計軸として扱います。

| 軸      | 方針                                                   |
| ------- | ------------------------------------------------------ |
| 寿命    | Rustが呼び出しごとの生成、長期保持、pool再利用を選ぶ   |
| 隔離    | アプリ・テナント・権限構成に応じてInstanceを割り当てる |
| 権限    | network、assets、DB、env等を明示的に渡す               |
| 互換性  | Web API profileと、追加するNode APIの範囲を識別する    |
| backend | 実行環境の寿命とは独立して選択する                     |

短命・長寿命とも同じApp / Invocationモデルを使います。Instanceはmodule状態を保持し、Invocationは一回の呼び出しの期限、キャンセル、host resourceを管理します。固定bindingをAppへ、リクエスト固有データを引数へ渡します。

コンパイル成果物はコード・backend版・profileに応じて共有し、実行状態はアプリ・テナント・権限境界に応じて再利用します。

## Responseと非同期処理の寿命

buffered経路では本文回収までInvocationを維持します。streamingでは返すBodyがInvocation / Instanceのleaseを保持し、本文完了・cancelまで実行環境を維持します。許可するbackground処理は明示的に登録し、期限と資源を追跡します。

中断や強制終了で実行環境の状態が不確かになった場合は、Instanceを退役させます。並行性は当面Instance間で作り、将来同一Instance内へ広げる際はtaskごとの文脈伝播を設計します。

## backendとWeb API

| 構成                  | 役割                            |
| --------------------- | ------------------------------- |
| QuickJS-NG / rquickjs | 軽量な組み込み候補              |
| Boa / boa_engine      | Rust製エンジンの候補            |
| V8 / deno_core        | V8による実行基盤                |
| Perry / scriptc       | ネイティブAOTのexperimental候補 |

Web APIはエンジンとは別の層です。共通の権限・所有権・適合テストを保ち、既存ライブラリとbackend固有実装も活用します。Cargo featureは `quickjs`（現在の既定）、`boa`、`v8`。依存・ビルド・release管理の利点が出た時点でbackend crate分割を検討します。

HonoにはFetch entry、SvelteKitとAstroにはworkspaceの専用build adapterを提供しています。SvelteKitの内部fetch、assets、platform情報もadapterの設計対象です。Nodeのlisten型アプリは、Node API互換とHTTP adapterを備える別の拡張として扱います。

## AOT

AOTは公開関数とFetch adapterという利用モデルを共有し、ロード・リンク・ABIを固有に扱います。compiler / runtime版、値の表現、初期化と解放、Promise、キャンセル、隔離を能力ごとに評価します。

Perry / scriptcの固定版で実行ファイルと静的ライブラリを検証済みです。以前のprofileでPerryのHono JSXと、scriptcのRust object経由の数値関数呼び出しに成功しました。現在のEncoding更新後はPerryのHonoに互換性課題があり、最新の結果を[AOTの実測](native-aot-backends.md#共通web-api更新後の実測)へ記録します。通常のRust/MSVCリンクとSvelteKitには再現可能な障害があり、詳細は[AOT調査](native-aot-backends.md)に記録しています。Appへの統合は次の段階です。

## 安全性と記録

信頼したアプリを制限された権限で動かす用途と、第三者コードを受け付ける用途に応じて隔離を設計します。後者はprocess / OS sandbox等による外側の強制を含めて評価します。backendごとの実効性を記録し、実測とソースからの推論を明示します。

検証記録には依存版、profile、入力、成功条件、失敗理由を残します。通常テスト、backend行列、host境界のfuzzingを維持し、仕様適合とアプリ互換性の両方を広げます。

## 関連する設計

- [Rust配布物にWeb UIを組み込む](embedded-applications.md)
- [プロセス内fetch](in-process-fetch.md)
- [backendに応じたpolyfillの選択](../packages/fetchlet/docs/build.md)

## 参照

- [Hono fetch](https://hono.dev/docs/api/hono#fetch) / [JSX](https://hono.dev/docs/guides/jsx)
- [SvelteKit adapters](https://svelte.dev/docs/kit/adapters)
- [Workers実行モデル](https://developers.cloudflare.com/workers/reference/how-workers-works/)
- [Workersのリクエスト固有状態](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/#do-not-store-request-scoped-state-in-global-scope)
- [V8 embedding](https://v8.dev/docs/embed)
- [workerdの隔離範囲](https://github.com/cloudflare/workerd#warning-workerd-is-not-a-hardened-sandbox)
