# 実装・検証状況

2026-11-16、Windows x64。固定したfixture、依存版、profileでの結果を記録します。

## ライブラリ

App / Module / Backend、任意関数の呼び出し、Fetch adapter、明示的envとservice、Rust経由の非同期fetchを実装しています。公開型はrootから再公開します。

| 経路                  | 現在の動作                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| App::call / call_json | Serde / JSONの引数、同期値とPromise、例外とrejectionを回収                                                       |
| App::fetch            | http Request / Response、本文の全量回収、binaryと複数Cookieを保持                                                |
| AppHandle::fetch      | Response本文をstreaming。需要駆動のpull、累積予算、期限、drop時のcancel                                          |
| Request本文           | bufferedでない本文をJSのReadableStreamとして需要駆動で供給し、宣言長と累積で予算を検査                           |
| Instance / FetchApp   | 低水準の関数呼び出しとFetch adapter                                                                              |
| HostServices          | 固定env、名前付きservice、外向きservice                                                                          |
| FetchService          | rewrite、最終originの認可、credentials、redirect制御。guestへは上流本文をstreaming、Rust呼び出しには回収して返却 |
| 実行管理              | InvocationによるFuture所有、通知駆動、協調的期限、中断後のInstance退役                                           |
| 構成                  | optional Limits、QuickJS heap / stack、V8 worker stack                                                           |

bundleはIIFEの `fetchletExports` に関数を公開します。JSON境界の値を扱い、JS固有のhandleは将来の値・resource ABIで設計します。streaming本文は完了・cancelまでInvocationとInstanceを保持します。所有関係と制約は[設計方針](design-proposal.md#streamingとbackground)にまとめています。

## 適合性の実測

[WPT / Test262の基盤](conformance.md)を追加しました。固定したWPT 86ファイル（各構成1451 subtest）、Test262 44ファイルのstrict / sloppy 88ケース、独自回帰22件を、Node参照と3VMで実行します。WPTはQuickJS 1210、Boa 1210、V8 1281、Node 1278成功で、残りはすべて分類・理由を記録した既知差分です。既知差分の多くは文書の基準URLやWPT serverを前提とする試験で、内訳は[適合性評価](conformance.md#現在の実測と既知差分)にまとめています。Test262と独自回帰は全構成で成功しています。結果は[conformance.json](../results/conformance.json)、既知差分は[expectations.json](../tests/conformance/expectations.json)です。通常の回帰判定とstrictな適合判定を分け、上流suite全体への評価は選定を広げて継続します。

## VMの実測

Web APIはfetchletの共通profileを使います。比較対象はrquickjs / boa_engine / deno_coreによる構成です。

| 構成                                  | 関数  | Hono JSX | SvelteKit | Web API |
| ------------------------------------- | ----- | -------- | --------- | ------- |
| QuickJS-NG / rquickjs 0.14.0          | 7 / 7 | 5 / 5    | 4 / 4     | 23 / 23 |
| Boa / boa_engine 0.22.0               | 7 / 7 | 5 / 5    | 4 / 4     | 23 / 23 |
| V8 / deno_core 0.413.0                | 7 / 7 | 5 / 5    | 4 / 4     | 23 / 23 |
| Node.js 26.13.1、native Web APIの参照 | 7 / 7 | 5 / 5    | 4 / 4     | 23 / 23 |

各構成は関数7、Hono5、SvelteKit4、Web APIプローブ群1の計17項目。[runtime-matrix.json](../results/runtime-matrix.json)と `results/web-api-*.json` に結果を保存します。

関数では数値、ネストしたobject、日本語・絵文字、Promise、状態再利用、throw、rejectionとエラー後の呼び出しを確認します。

Hono **4.13.18** はTSXの事前変換、escape、middleware、JSON POST、Cookie、JS stream、404を検査します。

SvelteKit **3.2.0** / Svelte **5.57.3** は実際のsveltekit buildとgenerateServerInstanceで、SSR、queryのescape、JSON endpoint、form actionを確認します。Svelteのprofileは `compilerOptions.experimental.async: false`。非同期actionは試験に含みます。AsyncLocalStorageを使う非同期SSRは別profileとして整備する対象です。

`crates/fetchlet/tests/instances.rs` は独立Instance、状態再利用、公開関数の選択、binary / Cookie変換、中断を確認します。検証CLIのスレッド設定は `crates/fetchlet/tests/support/lab/` に置きます。V8は専用worker上でisolateを保持し、値を通信します。

## 共通Web API profile

入口は `packages/runtime/src/index.ts`、各APIの実装は `packages/runtime/src/web/` にあります。URL、base64、structuredClone、DOMExceptionはcore-js-pure、Streamsはweb-streams-polyfill、Encodingは@exodus/bytes 1.16.0のencoding-liteを利用します。Rustのgetrandom / sha2をhost operation経由で使います。

| 範囲                 | 現在の実装と次の適合対象                                                                                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Headers / Body       | validation、record変換、二重消費、byte stream本文（BYOBを3VMで提供）、textStream、structuredCloneするclone、pipeToによる全量読み取り、binary、Cookie。guard / filtering / response typeへ拡張                              |
| Request              | 読み取り専用の属性accessor（mode、credentials、cache、referrer等）とRequestInitの検証。no-corsのheader guardへ拡張                                                                                                         |
| FormData / multipart | 重複項目とFile、byte単位のmultipart解析（行頭の区切り、preamble / epilogue、quoted boundary、UTF-8とescape、不正入力のTypeError）                                                                                          |
| Encoding             | UTF-8 / UTF-16 / single-byte、streaming / fatal、TextEncoderStream / TextDecoderStream                                                                                                                                     |
| Abort                | AbortSignal.abort / timeout / any、DOMException reason、本文読み取りとhost fetchのabort                                                                                                                                    |
| Crypto               | secure random、UUID v4、SHA-256                                                                                                                                                                                            |
| timer / job          | PromiseとsetTimeout / clearTimeout、Future通知による駆動                                                                                                                                                                   |
| fetch / env          | Rust serviceへの非同期bridge、origin policy、固定binding                                                                                                                                                                   |
| 本文・background     | Response本文のstreaming（`__fetchletResponseBodies`）、Request本文と上流Response本文のReadableStream化、byte storeによるbinary転送、`fetchlet.waitUntil` による応答後のbackground処理（期限・件数予算）、終了時のtimer回収 |
| 実行制御             | optionalな協調的期限とengine options。hard interruptとprocess境界を拡張                                                                                                                                                    |

23プローブとframework fixtureはアプリ互換性の足場です。標準適合の評価はAPIごとの試験とWPTへ広げ、Deno / LLRT等の既存実装も比較します。

## 実アプリのE2E

`examples/sveltekit-axum` はQuickJSでSSRを実行し、axumが静的assetsと動的Responseを配信します。16項目のHTTP / browser試験でhydration、form送信、client navigation、`platform.context.waitUntil` と、OriginRouterとaxum routerによるプロセス内Rust API（公開HTTPとの共用、HTTPエラー、信頼できるContext、origin policy、cancel、`event.fetch` の分担）も確認します。[実行手順](../examples/sveltekit-axum/README.md)、[結果](../results/example-sveltekit-axum.json)を参照してください。

## Host servicesと資源管理

3エンジンでJS fetchとRust mockを接続する33項目を検査します。通信権限、binary、Cookie、認証、redirect、rewrite、env、名前付きservice、abort、未完了処理の回収が対象です。[host-matrix.json](../results/host-matrix.json)に結果を保存します。

Rust側では所有権とpolicyの回帰テスト、[host境界のfuzzing](security.md)を維持します。各予算の適用箇所と、固定値を見直した根拠は[資源予算](resource-policy.md)にまとめています。

## AOTの実測

Perry **0.5.1665** / scriptc **0.4.14** の公式Windows配布物を固定し、SHA-256を確認して展開しました。scriptcのリンクにはZig **0.15.2** を使用しました。

| compiler / 入力          | 関数                | Hono JSX                      | SvelteKit                     |
| ------------------------ | ------------------- | ----------------------------- | ----------------------------- |
| Perry / module source    | 実行成功            | utf-16be Encoding初期化エラー | utf-16be Encoding初期化エラー |
| scriptc / module source  | 実行成功            | SC3004                        | SC0001 / SC1090               |
| Perry / bundled ES2019   | module sourceで評価 | utf-16be Encoding初期化エラー | utf-16be Encoding初期化エラー |
| scriptc / bundled ES2019 | module sourceで評価 | SC1090                        | SC0001 / SC1090               |

これは生成実行ファイルによるsmoke testです。関数は数値・object・Promise、FWは合成GETへのstatusと本文を成功条件にしています。[aot-matrix.json](../results/aot-matrix.json)に入力hash、終了コード、出力と失敗理由を記録しています。

以前のprofileではPerryのSvelteKit module sourceで `Receiver must be an instance of class PageNodes`、ES2019 bundleでportable trampolineの16引数上限に対しHono24 / SvelteKit21引数のpanicを確認しました。現在のEncoding構成では、これらの経路に先行してutf-16beの初期化で失敗します。scriptcはlowering、型、JSDoc import等の診断を返しました。これらはcompiler固有の互換性課題として再現を維持します。

### Rustへの静的リンク

| 構成                                                        | 実測                                    |
| ----------------------------------------------------------- | --------------------------------------- |
| Perry staticlib → Rust/MSVC                                 | iteratorとrust_eh_personalityの重複定義 |
| scriptc library → Rust/MSVC                                 | scr_win.oのCOMDAT、LNK1143              |
| scriptc library → Rust no_std object + C main + Zig GNU CRT | 初期化、add / multiplyと小数計算に成功  |

両compilerの静的ライブラリ生成に成功しています。scriptcのnative-link-infoはMSVC targetを記載し、driverはWindows GNU targetを指定していたため、最後の試験はCRTを揃えた最小ABI検証です。

[native-link-matrix.json](../results/native-link-matrix.json)が実測、`tools/test-native-link.ps1` が再現手順です。次は通常のCargoアプリとのリンク、文字列・バイト列の所有権、解放、例外、Promise、Fetch adapterを検証します。Appのbackendへ統合する前段階として維持します。

## 再現環境

Windows x64、Rust 1.100.0、Node 26.13.1、pnpm 12.21.0、Vite+ 1.6.0、TypeScript 6.0.3、Visual Studio / LLVMで実行しています。依存はCargo.lock / pnpm-lock.yaml、結果は `results/` に記録します。

```powershell
vp install --frozen-lockfile
vp run build:fixtures
vp run test:rust
vp run check:types
vp run check:format
vp run test:matrix
vp run test:host
vp run example:embed
```

AOT用の追加手順です。

```powershell
pwsh -File tools/install-aot.ps1 -Tool perry
pwsh -File tools/install-aot.ps1 -Tool scriptc
pwsh -File tools/install-zig.ps1
vp run test:aot
vp run test:native
```

compilerは `.cache/tools`、生成物は `artifacts`、詳細ログは `results/logs` に保存します。AOT行列は障害がある行を結果へ保存し、終了コード1を返します。最新版の実行結果と今回の再検証対象は[validation.json](../results/validation.json)を参照してください。

RustのWindows用スクリプトはCC / CXXをprocess内でclang-clに設定します。all-featureリンクでは `LNK4098 libcmt.lib` 警告が残っています。CRT構成の整理は配布前の作業です。

起動時間、RSS、配布サイズ、同一負荷の性能は次の計測対象です。

workspace移行後はRust本体・axum worker・3VMの互換性・host往復・browser E2E・ASan fuzzingを再検証しています。TypeScriptはSvelteKitのCompiler API互換範囲に揃え、通常のtsconfigでも型チェックを通しています。frameworkをIIFEへbundleする際の上流import.meta.dirname警告は残っています。

## 共有handleと2つのframework

AppHandleの3試験、streamingの13試験を3VMで確認しています。Rust HTTP統合はfetchlet-tower、fetchlet-hyper、fetchlet-axum、fetchlet-actixの4crateで、共通契約の8試験（公開origin・headers・binary・Set-Cookie・接続元、context、回収本文、streaming本文、エラー詳細とworker終了、信頼できるContext、切断によるcancel、origin検証）をそれぞれ3VMで実行します。fetchlet-hyperはloopbackの実TCP接続で実行します。Astro 7.4.12 / @astrojs/svelte 9.1.6の例を追加し、QuickJS＋FormatJSでSSRとSvelte islandを実行します。SvelteKit例はQuickJSを使い、両例で同じRust APIとartifact builderを利用します。Astro例はRequest本文をstreamingで受け、chunked uploadの受信と予算超過を検査します。結果（SvelteKit 9項目、Astro 10項目）はresults/example-{framework}-axum.jsonです。

AstroのIntl.DateTimeFormat要求はbuild backendに応じて満たします。QuickJS / BoaへはFormatJSの依存とlocaleデータを追加し、V8向けbundleはnative Intlを使います。[選択と実測](../packages/build/README.md)を参照してください。共通profileにはRustの単調時計に接続したperformance.now / timeOriginを追加しました。Web API層をframework評価前に初期化する順序を@fetchlet/buildで揃えています。

## 適合性改善後のAOT差分

Encodingを@exodus/bytesへ更新した後、PerryのHono module-sourceケースはnative TextDecoderのutf-16be初期化で失敗しています。plain関数はPerry / scriptcで継続して成功し、現行のAOT行列は2成功・8失敗です。以前のEncoding構成でのHono成功は過去の検証として保持し、現在の互換性は[aot-matrix.json](../results/aot-matrix.json)を基準にします。Perry向けprovider選択が次の互換性課題です。
