# 実行できるアプリの例

各例はfrontend build、Rustサーバ、設定、起動手順と実HTTP / browserのE2Eを持ちます。

| 組み合わせ                                         | backend           | 確認範囲                                                                           |
| -------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------- |
| [SvelteKit + axum](sveltekit-axum/README.md)       | QuickJS           | SSR、assets、hydration、action、endpoint、Rust service、client navigation          |
| [Astro + axum](astro-axum/README.md)               | QuickJS＋FormatJS | SSR、assets、Svelte island、フォーム、endpoint、Rust service、client navigation    |
| [Nuxt + axum](nuxt-axum/README.md)                 | QuickJS           | SSR、assets、hydration、server route、runtime config、Rust service、navigation     |
| [React Router + axum](react-router-axum/README.md) | QuickJS           | streaming SSR、assets、hydration、action、resource route、Rust service、navigation |

Next.js / vinext、TanStack Startは追加候補です。適したbuild出力とFetch entryから、実際に動くprofileを増やします。

## 共通にする境界

framework adapterはserver bundleとclient assetsを作ります。@fetchlet/buildがWeb APIの初期化順序とartifact形式を揃えます。Rust側はAppHandleで実行を管理し、現在の例はfetchlet-axumでHTTPを接続します。fetchlet-tower、fetchlet-hyper（hyper 1）、fetchlet-actix（actix-web）も同じ契約で検証済みです。

artifactはserver.js、client/、fetchlet.jsonです。manifestは形式版、entry、profile、frameworkと要求する能力を記録します。backendは要求に合わせてアプリ側で選択します。

## 追加するとき

- 名前を<framework>-<rust-server>とし、起動できるアプリを置く。
- RustとJSのpackageをそれぞれworkspaceへ登録する。
- framework固有の接続はpackages/のadapter / preset、HTTP統合はcrates/へ置く。
- 別のRustサーバでも同じframeworkのartifactを再利用する。
- E2EでHTML、公開assets、hydration、navigationと、その例が使うhost機能を確認する。
- framework / backend版とprofileを記録する。

共通のテスト用サーバ起動と結果保存はtools/testing/example-suite.mjsを使います。vp run test:examplesで4つの例を検証できます。
