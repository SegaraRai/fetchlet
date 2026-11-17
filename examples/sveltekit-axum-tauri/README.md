# Markdown Workspace（SvelteKit + axum / Tauri）

フォルダー内のMarkdownノートを閲覧・検索・編集するアプリ `mdw` です。1つのRustバイナリが、ブラウザー向けのローカルWebサーバ（`mdw serve`）とTauriのデスクトップウィンドウ（`mdw desktop`）の両方になります。画面はSvelteKitで作り、SvelteKitのサーバー側はfetchletがRustプロセス内のQuickJSで実行します。

```text
ブラウザー ──HTTP──┐
                     ├─ axum Router ─┬─ /api/v1/*  Rust API（utoipa、OpenAPI）
Tauri webview ─URI scheme─┘          ├─ /files/*   ワークスペースのファイル
                                     ├─ client/    JS / CSS
                                     └─ その他     SvelteKit（fetchlet / QuickJS）
                                                     └─ fetch("https://rust.fetchlet.test/…")
                                                          → 同じRust APIへプロセス内で到達
```

## 起動

リポジトリのルートで実行します。

```powershell
vp install --frozen-lockfile
vp run @fetchlet-internal/example-sveltekit-axum-tauri#serve          # ブラウザーで開く（mdw serve --open）
vp run @fetchlet-internal/example-sveltekit-axum-tauri#desktop  # デスクトップウィンドウで開く
```

taskは `sample/` を `.cache/sveltekit-axum-tauri/notes` へ一度だけ複製し、そのフォルダーを開きます。編集してもリポジトリのファイルは変わりません。複製を消すと最初の状態に戻ります。

buildした `mdw` は次のように使います。

```text
mdw serve [DIR] [--listen 127.0.0.1:4000] [--open]
mdw desktop [DIR]
mdw openapi [--output openapi.json]
mdw --config path/to/config.json …
```

`--config` を省くと実行ファイルの隣の `config.json`、なければこのディレクトリの `config.json` を使います。build済みのSvelteKit（`build/`）は設定ファイルからの相対パスで探します。

## 機能

| 機能                   | 実装                                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| ノートのツリーと閲覧   | Rustの索引から一覧を返し、SvelteKitがunified / remark / rehypeでHTMLへ描画                               |
| コードのハイライト     | 描画中のJSが、ノート内の全コードブロックを1回のプロセス内fetchでRustのsyntectへ渡す                      |
| 全文検索               | Rustの大文字小文字を区別しない部分一致検索。日本語も対象。結果の抜粋は一致箇所を構造化データで返す       |
| 編集とプレビュー       | remote `command` が入力中の本文をサーバー側で描画。保存はremote `form`（Ctrl+Sでも保存）                 |
| 競合の検出             | 内容のSHA-256をversionとし、読み込み時のversionと異なる保存を409で拒否。エディターで上書きか破棄を選べる |
| 外部での変更の反映     | `notify` の監視で索引を更新し、ブラウザーへはServer-Sent Events、ウィンドウへはTauri eventで通知         |
| 新規作成と削除         | remote `form` とvalibotの検証。既存の名前は入力欄のエラーとして返す                                      |
| JavaScriptなしでの利用 | 閲覧、検索（GETフォーム）、新規作成はSSRとフォーム送信で動く                                             |
| 画像などのファイル     | `/files/<path>` で配信。ノートの相対リンクと画像を、ノートのページと `/files` へ書き換える               |

## 型の共有

Rust APIの型はRustのhandlerが正本です。utoipaがhandlerとSerde型からOpenAPIを生成し、[@hey-api/openapi-ts](https://heyapi.dev/) がTypeScriptの型とfetch SDKにします。

```text
src/api/routes.rs ── mdw openapi ──▶ openapi.json ── openapi-ts ──▶ web/lib/api/（types.gen.ts、sdk.gen.ts、client）
                                                                        │
web/lib/server/rust.ts（SDKの再export） ◀──────────────────────────────┘
web/lib/notes.remote.ts（remote functions） ─▶ コンポーネント
```

- サーバー側JSは `rust.getNote({ query: { path } })` のように、utoipaのoperation IDから生成した関数を型付きで呼びます。引数の名前や型、応答の形の違いは `svelte-check` が型エラーにします。
- 生成したclientは `https://rust.fetchlet.test` を基準URLに持ち、実行時の依存packageはありません。設定は `openapi-ts.config.ts` です。
- remote functionsが、同じ型をブラウザー側のコンポーネントまで届けます。
- APIを変えたら `vp run --filter @fetchlet-internal/example-sveltekit-axum-tauri generate:api` で両方を再生成します。`cargo test` は、checked-inの `openapi.json` が現在のhandlerと一致することを確認します。

プロセス内のAPIと、`mdw serve` が `/api/v1` で公開するAPIは同じaxum Routerです。プロセス内のRequestはsocketを使わず、`fetchlet_axum::router_transport` からRouterへ届きます。fetch policyは `https://rust.fetchlet.test` だけを許可します。

## 構成

| 場所                    | 役割                                                                              |
| ----------------------- | --------------------------------------------------------------------------------- |
| src/cli.rs              | サブコマンド（serve / desktop / openapi）と設定ファイルの選択                     |
| src/host.rs             | ワークスペース、監視、Rust API、fetchletの起動。両方のshellが使うRouterの組み立て |
| src/serve.rs            | `mdw serve`。axumでHTTPを待ち受け、Hostヘッダーを検査                             |
| src/desktop/            | `mdw desktop`。URI scheme protocolとウィンドウ、変更のTauri event                 |
| src/api/                | utoipaで記述したhandler、OpenAPI、syntect、ファイル配信、Server-Sent Events       |
| src/workspace/          | パスの検証、索引、検索、楽観的並行制御つきの保存、ファイル監視                    |
| web/lib/notes.remote.ts | remote functions（query / command / form）                                        |
| web/lib/server/         | Markdownの描画、Rust APIの型付きclient                                            |
| web/lib/api/            | OpenAPIから生成した型とSDK（`openapi-ts.config.ts`）                              |
| openapi.json            | Rust APIのOpenAPI文書（生成物、checked-in）                                       |
| config.json             | 待受、キュー、本文、ノート、ファイル、索引の予算と監視の待ち時間                  |
| sample/                 | デモ用のノート                                                                    |
| tests/e2e.mjs           | `mdw serve` を実HTTPとChromiumで検証                                              |
| tests/desktop.mjs       | `mdw desktop` をWebView2のDevTools protocolで検証                                 |

## SvelteKitの設定

`compilerOptions.experimental.async` でコンポーネント内の `await` を、`experimental.remoteFunctions` でremote functionsを使います。adapterは `rendering: "async"` で、`node:async_hooks` の代わりにinvocation単位の `AsyncLocalStorage` を組み込みます（[SvelteKit adapter](../../packages/sveltekit-adapter/README.md)）。どちらもSvelteKit 3.2.0 / Svelte 5.57.3でexperimentalの機能です。

## ハイライトをRustで行う理由

ShikiのJavaScript正規表現エンジンをQuickJSで試したところ、grammarの正規表現が変換後にQuickJSのキャプチャ数上限（255）を超え、`too many captures` で失敗しました。V8では同じbundleが動き、初回264 ms、以降3〜8 msでした（開発機の計測、2026-11-17）。この例はQuickJSを既定とし、ハイライトをRustのsyntect（batのgrammarを含むtwo-face）に任せます。描画中のJSから型付きのプロセス内fetchで呼ぶため、JSのMarkdown処理系とRustのネイティブ処理を1回の描画で組み合わせる例にもなっています。remarkによる描画はQuickJSで1ノート数ms です。

## 権限と安全性

- APIが受け取るpathは、`/` 区切りの通常のセグメントだけです。`..`、絶対パス、ドライブ名、隠しファイル、Windowsで別名になる末尾のドットや空白、デバイス名を拒否します（`src/workspace/path.rs`）。
- 読み書きの前にcanonicalなパスがワークスペース内にあることを確かめ、外を指すシンボリックリンクを辿りません。索引もリンクを辿りません。保存は同じディレクトリの一時ファイルからのrenameで行います。
- ノート内の生のHTMLは描画時に取り除きます。`/files` の応答には `Content-Security-Policy: sandbox` と `X-Content-Type-Options: nosniff` を付け、SVGなどからscriptを実行させません。
- `mdw serve` は待ち受けたアドレスと一致するHostヘッダーだけに応答します（それ以外は421）。DNS rebindingで別のサイトが127.0.0.1を指しても、ノートを読めません。公開APIは `application/json` の本文、PUT、DELETEを使い、CORSヘッダーを返さないため、別のoriginのページからは送れません。SvelteKitのフォームはSvelteKitのorigin検査を受けます。
- `mdw serve` はローカルの単一ユーザー向けです。認証を持たないため、`--listen` で外部に公開しないでください。
- 以上の境界は `cargo test -p example-sveltekit-axum-tauri`（パス、リンク、予算、競合）とE2E（API、`/files`、Hostヘッダー、生のHTML）で検証しています。シンボリックリンクの試験は、Windowsでは開発者モードか管理者権限がないとskipします。

## 予算

`config.json` の値は、ローカルの単一ユーザー向けノートアプリとしてこの例が選んだものです。

| 項目                  | 既定値 | 内容                                                                     |
| --------------------- | ------ | ------------------------------------------------------------------------ |
| note_bytes            | 1 MiB  | 読み書きと索引の対象にするノートの最大サイズ。超えるノートは索引から除外 |
| workspace_notes       | 10,000 | 索引するノートの最大数。超えると起動時にエラー                           |
| file_bytes            | 16 MiB | `/files` で配信する1ファイルの最大サイズ                                 |
| request_body_bytes    | 2 MiB  | SvelteKitが受けるRequest本文（保存するノートを含む）                     |
| response_body_bytes   | 32 MiB | デスクトップのprotocolがwebviewへ返す応答の最大サイズ                    |
| invocation_timeout_ms | 10秒   | 1 RequestのJS実行の協調的な期限                                          |
| watch_debounce_ms     | 150 ms | ファイル変更をまとめて1回の再走査にする待ち時間                          |

Rust APIのRequest本文はnote_bytesの2倍までです（JSONのescapeを含むノート本文）。検索結果は1回50件まで（既定20件）で、検索画面と候補表示に必要な量です。

## デスクトップ版

`mdw desktop` はHTTPサーバを立てません。Tauriのカスタム URI scheme `mdw` が受けたwebviewのRequestを、`mdw serve` と同じaxum Routerへプロセス内で渡します。ページのURLはWindows（WebView2）とAndroidで `http://mdw.localhost/`、それ以外で `mdw://localhost/` で、アプリにはどのplatformでも `http://mdw.localhost` のURLが渡ります。

- Tauriの `UriSchemeResponder` は完成した本文を受け取るため、応答を `response_body_bytes` 以内で集めてから返します。Server-Sent Eventsの代わりに、変更はTauri event `workspace-changed` で届きます。
- `cargo build --no-default-features` で `desktop` featureを外すと、webviewのライブラリを必要としないCLIだけの `mdw` になります。
- 1つのバイナリがconsoleアプリなので、Windowsでエクスプローラーから起動するとconsoleも開きます。
- 自動検証はWindows（WebView2）で行っています。macOS（WKWebView）とLinux（WebKitGTK）はbuildと動作を確認していません。

## サーバー側のログ

`HostServices::console` で、SvelteKitの `console.error` などを `[js Error] …` の形で標準エラー出力へ流します（[Host services](../../docs/host-services.md)）。

## 検証

```powershell
vp run browser:install
vp run test:examples -- sveltekit-axum-tauri
```

frontendとRustをbuildし、`tests/e2e.mjs` と `tests/desktop.mjs` を実行します。

- e2e.mjs（14項目）：SSR、Rustでのハイライト、生のHTMLの除去、公開API、競合の409、ワークスペース外のpathの拒否、`/files` のsandbox、Hostヘッダー、hydrationと検索候補とクライアント遷移、エディターのプレビューとCtrl+Sでの保存、外部での変更の反映、エディターでの競合と上書き、remote formでの新規作成と検証、JavaScriptなしの検索と閲覧。結果は `results/example-sveltekit-axum-tauri.json` です。
- desktop.mjs（5項目、Windowsのみ）：URI schemeでの描画、プロセス内のハイライト、ワークスペースの境界、Tauri eventでの変更通知、protocol経由の保存。結果は `results/example-sveltekit-axum-tauri-desktop.json` です。

`cargo test -p example-sveltekit-axum-tauri` はpathの検証、検索と抜粋、索引、保存の並行制御、予算、シンボリックリンク、syntect、OpenAPI文書の一致を確認します。

## 次の作業

- `build/` を実行ファイルへ埋め込み、設定ファイルとbuildディレクトリなしで配布できる単一バイナリにする。
- Tauriのinstaller（`tauri build`）とフォルダー選択ダイアログ。
- 大きなワークスペース向けの永続的な検索index。
- fetchletのstreaming応答に合わせて、remote functionsの `query.live` で変更通知を受ける。
