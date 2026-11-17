# HonoX + Tauri

HonoXのSSR、islandのassets、API routeを、Tauri 2のwebviewへHTTPサーバなしで配信する例です。Rust側がfetchletの `AppHandle` を持ち、Tauriのカスタム URI scheme（`fetchlet`）が受けたwebviewのRequestをプロセス内でResponseにします。Tauri commandからはserver bundleのJS関数を汎用関数呼び出し（`AppHandle::call`）で呼びます。

## 起動

リポジトリのルートで実行します。

```powershell
vp install --frozen-lockfile
vp run @fetchlet-internal/example-honox-tauri#app
```

taskはclient（`--mode client`）とserverの2回buildしてからTauriアプリ（QuickJS）を起動します。Tauri CLIは使わず、`cargo run` で起動します。

## 構成

| 場所                  | 役割                                                             |
| --------------------- | ---------------------------------------------------------------- |
| app/                  | route、island、renderer、API route                               |
| app/functions.ts      | Rustから呼ぶJS関数（`greet`）                                    |
| vite.config.ts        | HonoXとfetchletのVite pluginとVite+のtask                        |
| src/protocol.rs       | URI scheme protocol。Rust route、client/のファイル、fetchletの順 |
| src/commands.rs       | Tauri command `greet`                                            |
| src/desktop.rs        | fetchletの起動、Tauriの組み立て、終了時のshutdown                |
| config.json           | キュー、本文予算、応答予算、期限、background予算、stack、backend |
| tauri.conf.json       | Tauriの設定。windowは `src/desktop.rs` が作る                    |
| capabilities/, icons/ | Tauriのcapabilityとアイコン                                      |
| tests/e2e.mjs         | WebView2をDevTools protocolで操作する検証                        |
| build/                | server.js、client/、fetchlet.json                                |

## 流れ

1. `src/desktop.rs` が `build/server.js` を読み、`App::builder(...).spawn(...)` でfetchletのworkerを起動します。
2. `register_asynchronous_uri_scheme_protocol("fetchlet", ...)` がwebviewのRequestを `Protocol::respond` へ渡します。
3. `Protocol` は `/api/rust` をRustで答え、`build/client` のファイルをtower-httpの `ServeDir` で返し、それ以外を[fetchlet-http](../../crates/fetchlet-http)の `FetchletService` でHonoXへ渡します。axumには依存しません。
4. island `greeter` は `@tauri-apps/api` の `invoke("greet")` を呼び、commandが `AppHandle::call("greet", ...)` で `app/functions.ts` の `greet` を実行します。

`functions` は[fetchlet/hono](../../packages/fetchlet/docs/hono.md)の設定で、指定したmoduleのnamed exportをFetch handler `handle` と並べてserver.jsへ出力します。commandは呼ぶexport名を固定しているため、webviewから `handle` や他のexportは呼べません。

## originとURL

webviewのURLはWindows（WebView2）とAndroidで `http://fetchlet.localhost/`、それ以外で `fetchlet://localhost/` です。アプリにはどのplatformでも `http://fetchlet.localhost` + path + queryのURLが渡ります（`FetchletService` のpublic origin）。Tauriは登録済みURI schemeのページをlocalとして扱うため、このページからTauriのIPCを使えます。

## backendの切り替え

```powershell
$env:FETCHLET_BACKEND = 'v8'; vp run --filter @fetchlet-internal/example-honox-tauri build
node tools/workspace/cargo.ts run -p example-honox-tauri --features v8
```

`FETCHLET_BACKEND`（`quickjs` / `boa` / `v8`）がartifactのbackendを決め、`config.json` の `"backend"` がRust側のBackendを選びます。featureを付けずにbuildしたアプリはBoa / V8の設定を起動時にerrorにします。E2Eは `FETCHLET_BACKEND` を設定するとconfig.jsonのbackendも合わせます。QuickJS / Boa / V8の3つで同じE2Eが通ることを確認しています。

## 制約

- 応答はまとめて返します。Tauriの `UriSchemeResponder` は完成した本文を受け取るため、fetchletのstreaming応答は `response_body_bytes`（16 MiB）以内で集めてから返し、超えると502にします。この予算は呼び出し側の方針としてconfig.jsonに置いています。
- 要求本文はwebviewが集めてから渡します。`FetchletService` は `request_body_bytes` 以内で受け、超えると413にします。axum例の到着順のstreaming uploadは扱いません。
- 接続元はありません。`/api/context` の `clientAddress` は省かれます。
- `tauri.conf.json` の `csp` はnullです。TauriのCSP注入は組み込みのasset protocolに対するもので、このschemeの応答には付きません。CSPが必要な場合はアプリの応答headerで指定します。
- `build/` はconfig.jsonの場所から読みます。`tauri build` によるinstallerの作成と、resourceとしての同梱は次の対象です。
- 自動検証はWindows（WebView2）で行っています。macOS（WKWebView）とLinux（WebKitGTK）はbuildと動作を確認していません。LinuxでのbuildにはWebKitGTKなどTauriの前提packageが必要です。
- release buildはWindowsでconsoleを開かないため、標準出力の `FETCHLET_TAURI_READY` とerror出力は表示されません。

## 検証

```powershell
vp run test:examples -- honox-tauri
```

frontendとアプリをbuildし、`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>` でアプリを起動してPlaywrightの `connectOverCDP` で接続します。要求はすべてwebview内から出すため、URI scheme protocolを通ります。SSRとescape、Rust serviceのbinding、JS / CSS / 公開ファイルとclient/外の非公開、JSON endpoint、接続元なしのcontext、protocolのRust route、本文予算、`waitUntil`、並行Request、hydration、commandからのJS関数呼び出し、navigationを確認します。結果はresults/example-honox-tauri.jsonです。Windows以外ではskipします。

`cargo test -p example-honox-tauri` はwebviewなしで `Protocol` を検証します。client/のファイルとpublic originでの描画、`..` によるclient/外の読み出しの拒否、要求本文と応答本文の予算を確認します。`vp run test:rust` に含まれます。
