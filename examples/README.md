# 実行できるアプリの例

各例はfrontend build、Rustのhost、設定、起動手順とE2Eを持ちます。axumの例は実HTTPとbrowser、Tauriの例はwebviewで検証します。

| 組み合わせ                                                 | backend           | 確認範囲                                                                                                                                                         |
| ---------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [SvelteKit + axum](sveltekit-axum/README.md)               | QuickJS           | SSR、assets、hydration、action、endpoint、Rust service、client navigation                                                                                        |
| [Astro + axum](astro-axum/README.md)                       | QuickJS＋FormatJS | SSR、assets、Svelte island、フォーム、endpoint、Rust service、client navigation                                                                                  |
| [Nuxt + axum](nuxt-axum/README.md)                         | QuickJS           | SSR、assets、hydration、server route、runtime config、Rust service、navigation                                                                                   |
| [React Router + axum](react-router-axum/README.md)         | QuickJS           | streaming SSR、assets、hydration、action、resource route、Rust service、navigation                                                                               |
| [HonoX + axum](honox-axum/README.md)                       | QuickJS           | SSR、assets、island、API route、Rust service、navigation                                                                                                         |
| [TanStack Start + axum](tanstack-start-axum/README.md)     | QuickJS           | streaming SSR、assets、hydration、server function、server route、Rust service、client navigation                                                                 |
| [SolidStart + axum](solidstart-axum/README.md)             | QuickJS           | streaming SSR、assets、hydration、server function、API route、Rust service、client navigation                                                                    |
| [Qwik City + axum](qwik-city-axum/README.md)               | QuickJS           | SSR、assets、resumability、routeLoader$、endpoint、Rust service、client navigation                                                                               |
| [Waku + axum](waku-axum/README.md)                         | QuickJS           | RSC、SSR、assets、hydration、API route、Rust service、client navigation                                                                                          |
| [vinext + axum](vinext-axum/README.md)                     | QuickJS           | App Router、RSC、SSR、assets、hydration、route handler、Rust service、client navigation                                                                          |
| [HonoX + Tauri](honox-tauri/README.md)                     | QuickJS           | HTTPサーバなしのURI scheme配信、SSR、assets、island、API route、Tauri commandからのJS関数呼び出し                                                                |
| [SvelteKit + axum / Tauri](sveltekit-axum-tauri/README.md) | QuickJS           | Markdownワークスペース。CLIのHTTPとTauriのURI schemeで同じRouterを配信、utoipaのOpenAPIから型共有、remote functions、async SSR、Rustでのハイライト、ファイル監視 |

後半の6例は共通の10項目（tools/examples/common-checks.ts）で同じアプリの形を確認します。Next.js本体（`next build` の出力）、Qwik 2、SolidStartのNitro経由のbuildは次の対象です。

## 共通にする境界

framework adapterはserver bundleとclient assetsを作ります。fetchlet/buildがWeb APIの初期化順序とartifact形式を揃えます。Rust側はAppHandleで実行を管理し、axumの例はfetchlet-httpの `Artifact` と `artifact_router` でartifactを読み、client assetsとアプリを配信します。Tauriの例はfetchlet-httpの `FetchletService` をURI scheme protocolから呼び、HTTPサーバを立てずにwebviewへ配信します。fetchlet-tower、fetchlet-hyper（hyper 1）、fetchlet-actix（actix-web）も同じ契約で検証済みです。

artifactはserver.js、client/、fetchlet.jsonです。manifestは形式版、entry、profile、frameworkと要求する能力を記録します。backendは要求に合わせてアプリ側で選択します。

## backendの切り替え

各例の既定はQuickJSです。Boa / V8で動かすときは、artifactとサーバを同じbackendに揃えます。

```bash
FETCHLET_BACKEND=v8 vp run --filter @fetchlet-internal/example-honox-axum build
```

```bash
node tools/workspace/cargo.ts run --release -p example-honox-axum --features v8
```

`FETCHLET_BACKEND`（`quickjs` / `boa` / `v8`）はframework設定のbackendをbuild時に上書きし、`config.json` の `"backend": "v8"` がRust側のBackendを選びます。featureを付けずにbuildしたサーバはBoa / V8の設定を起動時にerrorにします。V8の `worker_stack_bytes` はV8のworker threadにも使います。

[tools/bench](../tools/bench/README.md)は10例 × 3 backend × endpointのreq/sを測ります。

## 追加するとき

- 名前を<framework>-<rust-host>（axum、tauriなど）とし、起動できるアプリを置く。
- RustとJSのpackageをそれぞれworkspaceへ登録する。
- framework固有の接続はpackages/のadapter / preset、HTTP統合はcrates/へ置く。
- 別のRustサーバでも同じframeworkのartifactを再利用する。
- E2EでHTML、公開assets、hydration、navigationと、その例が使うhost機能を確認する。
- framework / backend版とprofileを記録する。

共通のテスト用サーバ起動と結果保存はtools/examples/suite.tsを使います。vp run test:examplesで全例を検証できます。Tauriの例は独自のE2E（WebView2のDevTools protocol）を使います。
