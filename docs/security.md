# 安全性と検証

fetchletのsecureは、明示的な権限、資源の所有権、用途に応じた隔離、それらを継続的に確かめるテストとfuzzingから構成します。

## 現在の実行境界

| 対象               | 実装している契約                                               |
| ------------------ | -------------------------------------------------------------- |
| 外向きfetch        | 指定したserviceと、許可した正規化originへの通信。`globalThis.fetch` はWebIDLと同じく書き換え可能で、置き換えたfetchもhostのfetchとRustのpolicyを通る |
| 書き換えとredirect | 最終宛先を送信のたびに認可し、認証情報を送信先に結び付ける     |
| envとservice       | Rustが指定したbindingをmodule評価前に固定                      |
| JS状態             | App内で再利用。アプリ・テナント・権限構成ごとにAppを割り当てる |
| 非同期資源         | Invocationがtransport Futureを所有し、終了時にdrop             |
| ticket             | Invocationの世代と結び付け、同じ呼び出し内で完了を一回配送     |
| 中断               | 中断済みまたは未完了処理を残したInstanceを退役                 |
| host error         | guestへ安定したcodeと一般化したmessageを公開                   |
| 資源予算           | 呼び出し側がLimitsとengine optionsを選択                       |

transportもこの境界の一部です。single-hop、Future dropによる中断、受信中のサイズ検査、DNS・接続先IPのpolicyをRust側で実装します。[Host services](host-services.md)と[資源予算](resource-policy.md)に詳細をまとめています。

## 運用と隔離

現在の検証対象は、信頼したアプリケーションコードを同一process内で動かす構成です。権限policyはfetchletのhost operationを制御します。エンジンの実装バグやネイティブコードのメモリ破壊まで含む隔離は、process / OS sandbox等の外側の境界で設計します。

timeoutは協調的です。yieldしないJSや初期化の強制停止、heap全体の制御はbackendごとの拡張対象です。第三者のコードを受け付ける用途では、必要な強制力と各backendの能力を評価して構成します。AOTはネイティブコードとして扱います。

Web API profileは、固定したSSRアプリを対象に検証を重ねている開発段階です。標準適合は固定版のWPT / Test262と独自回帰で評価し、選定・未対応mode・既知失敗を[適合性評価](conformance.md)へ記録します。

## 通常のテスト

```powershell
vp run test:rust
vp run build:fixtures
vp run test:matrix
vp run test:host
```

Rust側はoriginの完全一致、rewrite / redirectの認可順序、認証情報の寿命、body / header予算、不正header / status、Future破棄、ticket寿命、Appの状態遷移を確認します。

VM間の行列は本物のbundleを使います。プレーン関数、Hono JSX、SvelteKit SSR / action、23項目のWeb APIプローブとhost往復を検査します。Nodeの参照実行も同じfixtureに使います。結果の対象は、記録した依存版・profile・fixtureです。

WPTとTest262の原本はライセンス・固定commit・hashを保存して検証します。新規失敗、timeout、harnessエラーと改善をCIで検出し、既知失敗も実測failとして残します。runner自己試験はassertionの失敗、async完了、global script、modeとprocess終了を確認します。

## fuzzing

`fuzz/fuzz_targets/fetch_service.rs` はURL、method、header、本文、rewrite先、redirect列を変異させ、実際のRust FetchServiceとmock transportを実行します。transportへ渡る全Requestのorigin、method、framing headerとredirect回数を検査します。対象はRustのhost fetch境界です。

`fuzz/fuzz_targets/bridge_bodies.rs` はguestがnative callbackで行える操作列を変異させます。対象はbyte handleの格納・取得、本文sourceの `body.read` / `body.cancel` / `fetch.poll`、任意のhost operation、生産者のchunk・終端・中断、Invocationの開始・終了です。結果をモデルと照合し、次を検査します。

- guestのbufferは一度だけ取り出せ、未取得のものは最新の1つだけが残る
- handleと本文idはInvocationを越えて届かない
- 本文の読み取りは生産者のchunkを順に、予算の範囲で返す
- 完了・エラー・cancel・Invocation終了で生産者を解放し、同じ本文の読み取りは同時に1つ

private bridgeへは `fuzzing` featureの隠しharness（`BridgeHarness`）から接続します。生産者の解放を故意に止める変異は数秒でモデルが検出することを確認しています。

corpusの種は `fuzz/corpus/fetch_service/*.json`、生成corpusとcrash artifactはローカル保存です。failureは最小化して回帰テストへ取り込みます。fuzz crateは通常のライブラリとCargo workspace / Cargo.lockを共有します。

```powershell
cargo install cargo-fuzz --version 0.13.2 --locked --root .cache/tools/cargo-fuzz
vp run test:fuzz
```

nightly Rustを使います。WindowsではVisual Studio C++ AddressSanitizerが必要です。`tools/test-fuzz.ps1` はMSVCを検出し、ASan runtimeのPATHを設定します。[公式Windows setup](https://rust-fuzz.github.io/book/cargo-fuzz/windows/setup.html)

既定のsmoke runは各targetをAddressSanitizer付きで最大100万回・30秒実行します。実行回数と時間予算はスクリプトの引数で変更できます。[fuzz-smoke.json](../results/fuzz-smoke.json)にcompilerと結果を残します。

## 継続検証

`.github/workflows/test.yml` にWindows / LinuxのRustテスト、型・formatチェック、framework / host行列、LinuxのAddressSanitizer付きfuzzingを設定しています。現在の実行確認はWindowsローカルの結果で、remote CIの実行確認は次の運用作業です。

AOTは独立したsmoke testと失敗再現を維持し、同期関数、ABI、非同期処理、Fetch adapterの能力を個別に評価します。

共有handleでは、開始を確認した呼び出しの中断、キューのbackpressure、shutdown時の受付終了とdrainを3VMで試験します。axum統合ではorigin、本文予算、client context、binary / Cookieと一般化したエラー応答を検査します。AstroとSvelteKitの実browser試験も継続検証へ追加しています。
