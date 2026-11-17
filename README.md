# fetchlet

RustアプリケーションにJavaScriptの関数とFetchハンドラを組み込むライブラリです。

選べるバックエンドと、その能力に合わせたWeb API・polyfillを通じて、サーバーサイドJSをRustアプリへ手軽に統合します。

主用途は、Hono JSX、SvelteKit、Astro、Nuxt、React Routerなどのサーバー側処理をRustアプリへ組み込み、リッチなWeb UIを提供することです。特にCLI付属UI、ローカルツール、セルフホストなど、一つのRust配布物にまとめたい用途を重視します。RustがRequestを渡し、JSで生成したResponseを受け取ります。任意の同期・非同期関数も同じ実行基盤から呼び出せます。

```rust
use std::num::NonZeroUsize;
use fetchlet::{App, Backend, Body, Module, WorkerOptions, http};

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    let source = std::fs::read_to_string("artifacts/functions-hono.js")?;
    let app = App::builder(Backend::quickjs())
        .module(Module::new(source))
        .spawn(WorkerOptions::new(NonZeroUsize::new(8).unwrap()))
        .await?;

    let request = http::Request::builder()
        .uri("https://fetchlet.invalid/hello/Rust")
        .body(Body::empty())?;

    let response = app.fetch(request).await?;
    let body = response.into_body().collect(1024 * 1024).await?;
    println!("{}", std::str::from_utf8(&body)?);
    app.shutdown().await?;

    Ok(())
}
```

この例のbundleは `vp run build:fixtures` で生成します。本文回収の1 MiBとキュー8件は、この例の呼び出し側が選ぶ予算です。`app.call("transform", &input)` でSerde対応の関数を、`app.call_json("add", &[...])` で複数引数の関数を呼び出せます。

複製できるAppHandleは、AppBuilder::spawn(WorkerOptions)で作れます。所有スレッド、待機キュー、中断後のInstance再生成と終了待ちを扱います。HTTPサーバへはfetchlet-httpで接続します。Towerと `http` 1系のserviceは常に使え、`hyper`、`axum`、`actix` featureで各サーバ向けの層を加えます。すべての層を同じ契約試験で検証しています。

Cargo featureで `quickjs`（既定）、`boa`、`v8` を選択できます。複数の同時有効化にも対応します。AOTはexperimentalな比較・リンク検証として維持しています。

`HostServices` は明示的なenv、名前付きRustサービス、外向きfetchを提供します。通信先は `FetchPolicy` で許可し、送信前の書き換えや認証情報の付与をRustで行います。`Limits` の各項目は呼び出し側が設定する資源予算です。

開発版では、固定したHono／SvelteKit fixtureと共通Web API profileを3エンジンで検証しています。本文はバッファ方式、期限は協調的です。実運用の隔離、HTTP transport、資源予算はホスト側の構成と合わせて設計します。

- [Host servicesの使い方](docs/host-services.md)
- [資源予算と仕様由来の上限](docs/resource-policy.md)
- [安全性と検証](docs/security.md)
- [WPT / Test262による適合性評価](docs/conformance.md)
- [コンセプトと方針](docs/project-brief.md)
- [組み込みアプリ・配布・Tauri連携の方針](docs/embedded-applications.md)
- [プロセス内fetch](docs/in-process-fetch.md)
- [設計と拡張計画](docs/design-proposal.md)
- [実装・検証状況](docs/implementation-status.md)
- [既存Web API実装の調査](docs/backend-web-api-support.md)
- [AOTの調査](docs/native-aot-backends.md)

## 起動できる例

[SvelteKit + axum](examples/sveltekit-axum/README.md) はSSR、JS / CSS配信、form action、Rustサービスbindingを備えたアプリです。

```powershell
vp install --frozen-lockfile
vp run @fetchlet-internal/example-sveltekit-axum#serve
```

ブラウザで `http://127.0.0.1:3000` を開きます。HTTPサーバはRustが起動し、専用スレッドでJSを実行します。

Astro＋axumの例も `vp run @fetchlet-internal/example-astro-axum#serve` で起動できます（http://127.0.0.1:3100、QuickJS＋FormatJS）。[Nuxt + axum](examples/nuxt-axum/README.md)（`vp run @fetchlet-internal/example-nuxt-axum#serve`、http://127.0.0.1:3200）はNitro presetで、[React Router + axum](examples/react-router-axum/README.md)（`vp run @fetchlet-internal/example-react-router-axum#serve`、http://127.0.0.1:3300）はReact Router presetでbuildします。HonoX（3400）、TanStack Start（3500）、SolidStart（3600）、Qwik City（3700）、Waku（3800）、vinext（3900）の例も `vp run @fetchlet-internal/example-<name>#serve` で起動できます（[一覧](examples/README.md)）。10の例は同じRustの公開APIを使います。adapterのbackend設定から不足するIntl APIを選び、localeとタイムゾーンデータを絞って組み込みます。[polyfillの選択](packages/fetchlet/docs/build.md)を参照してください。

[Markdown Workspace](examples/sveltekit-axum-tauri/README.md) は実用アプリの例です。1つのRustバイナリ `mdw` がCLIのWebサーバ（`vp run @fetchlet-internal/example-sveltekit-axum-tauri#serve`）とTauriのデスクトップアプリ（`vp run @fetchlet-internal/example-sveltekit-axum-tauri#desktop`）を兼ね、SvelteKitのserver JSがutoipaのOpenAPIから生成した型でRust APIをプロセス内fetchで呼びます。

## Workspace

```text
crates/fetchlet/              関数・Fetch実行、共有handle、host services
crates/fetchlet-http/         Tower / hyper / axum / actix-webのHTTP統合、artifact配信
tools/lab/                    toolsが使う行プロトコルのhost（fetchlet-lab）
packages/fetchlet/            npmパッケージfetchlet：runtime、artifact builder、各framework adapter
examples/sveltekit-axum/      QuickJSで動くSvelteKit例
examples/astro-axum/          QuickJS＋Intl polyfillで動くAstro例
examples/nuxt-axum/           QuickJSで動くNuxt例
examples/react-router-axum/   QuickJSで動くReact Router例
examples/<framework>-axum/    HonoX、TanStack Start、SolidStart、Qwik City、Waku、vinextの例
examples/sveltekit-axum-tauri/ CLIとTauriを兼ねるSvelteKitのMarkdownワークスペース
fixtures/                    backend互換性の回帰試験
fuzz/                        Rust host境界のfuzzing
```

Rustの共通依存とlockfileはworkspaceで管理します。JS側もpnpm workspaceで接続します。将来のframework / Rustサーバの追加方針は[examples](examples/README.md)を参照してください。

## 開発と検証

```powershell
vp install --frozen-lockfile
vp run check
vp run test:rust
vp run test:matrix
vp run test:host
vp run example:embed
```

依存の版はCargo.lockとpnpm-lock.yamlに固定しています。fuzzingの準備と実行は[安全性と検証](docs/security.md)を参照してください。
