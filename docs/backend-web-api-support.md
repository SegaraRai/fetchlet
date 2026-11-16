# 既存Web API実装の調査

2026-11-16。公開crateと固定upstreamのソース調査です。fetchletの共通profileによる実行結果は[実装・検証状況](implementation-status.md)で記録します。

## 組み込みの選択肢

| 構成                        | 活用できる点                               | 組み込みで整える範囲                                      |
| --------------------------- | ------------------------------------------ | --------------------------------------------------------- |
| QuickJS / LLRT              | 軽量なengineと個別Web APIモジュール        | 採用版の固定、Body / Streamsの接続、Rust host I/Oへの置換 |
| V8 / Deno拡張 / rustyscript | 広いWeb APIと既存の初期化                  | permission設定、依存crate群の整合、Rust Bodyとの接続      |
| Boa / boa_runtime           | Rust製engine、基本Fetch / Encoding / Abort | Request / Bodyの拡張、Streams / FormData等の追加          |

Web APIの存在、仕様適合、framework互換性、Rustへの変換をそれぞれ評価します。JS内のStreamsと、Rustに本文を渡す方法も別の層です。fetchletの共通profileは3VMでHono / SvelteKit fixtureと23プローブを通過しています。LLRT / Deno / boa_runtime構成の評価は、ここではソース調査の段階です。

## 調査対象

| 対象                         | レジストリの確認版                     | ソースの確認範囲                                                           |
| ---------------------------- | -------------------------------------- | -------------------------------------------------------------------------- |
| rquickjs                     | 0.14.0                                 | Rust バインディング。Web API は別実装                                      |
| llrt_fetch / llrt_stream_web | 0.8.1-beta                             | レジストリから取得したソースアーカイブ                                     |
| LLRT upstream                | manifest は 0.10.0-beta、rquickjs 0.14 | `5f62b24cf647d20ad832f793993fd90b3137b0a2`                                 |
| boa_runtime / boa_engine     | 0.22.0                                 | boa_runtime / boa_wintertc の公開アーカイブ                                |
| Boa upstream                 | 開発版                                 | `bea404d173bf74a64b7c7ae39b1bc2da639abeee`                                 |
| rustyscript                  | 0.12.3                                 | 公開アーカイブ。deno_fetch ^0.237.0 / deno_web ^0.244.0 を参照             |
| rustyscript upstream         | manifest の版表示は 0.12.3             | `ef6ccee0eb45378dba540ebe78005f05ed3aa81b`。公開アーカイブと依存版が異なる |
| deno_core                    | 0.413.0                                | 公開版メタデータ。Deno 拡張の説明に用いたソースは下記 SHA                  |
| Deno upstream                | 開発版                                 | `e7b39ebd55c85aaf6a29290c1f5a99e2e21e09dd`                                 |
| Hono upstream                | 開発版                                 | `f6fbaf0299c48eea9e656e03e2ffe7ac755e8823`                                 |
| SvelteKit upstream           | 開発版                                 | `407ef8cb1257d0d7529db6ebde1130654ffd8fe4`                                 |

Deno拡張を組み込む際は、対応するcrate群とCargo.lockを一式で固定します。公開アーカイブのURL、SHA-256、VCS情報は[release-source-manifest.json](research/2026-11-16/release-source-manifest.json)、upstreamの確認ファイルは[upstream-sources.json](research/2026-11-16/upstream-sources.json)に保存しています。

## APIの確認結果

「実装」はソースと登録処理の確認、「部分」は確認した範囲の実装、「なし」は当該構成の登録・実装にAPIが見当たらないことを表します。表はソース調査で、仕様適合率は専用試験で測定します。

| API / 振る舞い                             | LLRT crates 0.8.1-beta                  | LLRT upstream 固定 SHA         | rustyscript 0.12.3 + web   | boa_runtime 0.22.0              |
| ------------------------------------------ | --------------------------------------- | ------------------------------ | -------------------------- | ------------------------------- |
| Request の生成                             | 実装                                    | 実装                           | 実装                       | 部分                            |
| Request の JS 側 url / method / headers    | 実装                                    | 実装                           | 実装                       | なし                            |
| Response の status / headers / text / json | 実装                                    | 実装                           | 実装                       | 実装                            |
| Request / Response の arrayBuffer          | 実装                                    | 実装                           | 実装                       | なし                            |
| Response のバイナリ BodyInit               | 実装、細部は未検証                      | 実装                           | 実装                       | なし。文字列化される            |
| Response.body が ReadableStream            | なし。undefined                         | 実装                           | 実装                       | なし                            |
| ReadableStream / WritableStream            | 別モジュールに実装                      | 実装                           | 実装                       | なし                            |
| TransformStream                            | なし                                    | 実装                           | 実装                       | なし                            |
| TextEncoder / TextDecoder                  | util に実装                             | util に実装                    | 実装                       | text に実装                     |
| TextEncoderStream / TextDecoderStream      | なし                                    | util に実装                    | 実装                       | なし                            |
| URL / URLSearchParams                      | url に実装                              | url に実装                     | 実装                       | URL のみ。searchParams はエラー |
| FormData / Blob / File                     | fetch / buffer に実装、部分互換         | 実装、詳細な適合性は未検証     | 実装                       | なし                            |
| Request.formData の multipart              | 実装、細部は未検証                      | 実装                           | 実装                       | なし                            |
| Request.formData の URL encoded            | 部分。標準の結果にならない経路あり      | 専用経路あり                   | 実装                       | なし                            |
| Headers.getSetCookie                       | 実装                                    | 実装                           | 実装                       | 実装                            |
| AbortController / AbortSignal              | abort に実装                            | abort に実装                   | 実装                       | 部分実装                        |
| setTimeout / queueMicrotask                | timers に実装                           | timers に実装                  | 実装                       | 実装、ホストの job 駆動が必要   |
| structuredClone                            | モジュール一式だけでの提供は未確認      | llrt_core 側に実装             | 実装                       | 実装                            |
| crypto / subtle                            | crypto に実装、対応アルゴリズムは別評価 | 実装、対応アルゴリズムは別評価 | crypto 拡張を登録          | 標準構成での提供なし            |
| 外向き fetch                               | fetch に実装、HTTP 初期化が必要         | 同左                           | 実装、ホスト権限の設定対象 | Fetcher の明示的な登録が必要    |

## QuickJS / LLRT

rquickjsはQuickJS-NGのRust bindingで、Promise / Future連携、loader、値変換を提供します。Web APIは追加する層として選択します。[rquickjs 0.14.0](https://docs.rs/rquickjs/0.14.0/rquickjs/)

公開llrt_fetch 0.8.1-betaはbuffer中心です。Response.bodyはundefined、Request.bodyは入力値かnullを返し、stream化はTODOです。llrt_stream_webにはReadable / WritableStream、llrt_utilにはTextEncoder / TextDecoderがあります。[Response](https://docs.rs/crate/llrt_fetch/0.8.1-beta/source/src/response.rs)、[Request](https://docs.rs/crate/llrt_fetch/0.8.1-beta/source/src/request.rs)、[Streams](https://docs.rs/crate/llrt_stream_web/0.8.1-beta/source/src/lib.rs)、[util](https://docs.rs/crate/llrt_util/0.8.1-beta/source/src/lib.rs)

FormData.getは逆順走査で重複キーの最後を返します。Request.formDataはmultipartを経由し、boundaryのない入力で空の結果となる経路があります。標準の重複キーとURL encodedの扱いは適合試験の対象です。[FormData](https://docs.rs/crate/llrt_fetch/0.8.1-beta/source/src/form_data.rs)

固定upstreamではRequest / ResponseにReadableStreamとclone時のtee、TransformStream、Encoding Streamsが追加されています。実装ファイルと登録コードを根拠に確認しています。[Response](https://github.com/awslabs/llrt/blob/5f62b24cf647d20ad832f793993fd90b3137b0a2/modules/llrt_fetch/src/response.rs#L304)、[Streams登録](https://github.com/awslabs/llrt/blob/5f62b24cf647d20ad832f793993fd90b3137b0a2/modules/llrt_stream_web/src/lib.rs#L157)、[Encoding登録](https://github.com/awslabs/llrt/blob/5f62b24cf647d20ad832f793993fd90b3137b0a2/modules/llrt_util/src/lib.rs#L104)

組み込みではModuleBuilderや個別initで必要なAPIを選びます。fetch initはHTTP clientも参照するため、型の登録とRust側通信制御を分ける作業が必要です。structuredCloneはllrt_core側のVM初期化にあります。[ModuleBuilder](https://github.com/awslabs/llrt/blob/5f62b24cf647d20ad832f793993fd90b3137b0a2/llrt_modules/src/module_builder.rs)、[fetch init](https://github.com/awslabs/llrt/blob/5f62b24cf647d20ad832f793993fd90b3137b0a2/modules/llrt_fetch/src/lib.rs#L28)、[VM init](https://github.com/awslabs/llrt/blob/5f62b24cf647d20ad832f793993fd90b3137b0a2/llrt_core/src/vm.rs#L200)

公開版はrquickjs 0.11、固定upstreamは0.14です。Value / Context / Classを共有するために版を揃えます。公開アーカイブにはVCS dirty情報と依存別名もあり、採用元のソース同一性をmanifestで確認します。[公開manifest](https://docs.rs/crate/llrt_fetch/0.8.1-beta/source/Cargo.toml.orig)、[upstream manifest](https://github.com/awslabs/llrt/blob/5f62b24cf647d20ad832f793993fd90b3137b0a2/modules/llrt_fetch/Cargo.toml)

## V8 / Deno / rustyscript

deno_coreはJS実行、event loop、Rust opの基盤です。Request / Responseはdeno_fetch、Streams / Encoding / Blob / Abortはdeno_web、URLとCryptoは対応する拡張で提供します。

rustyscript 0.12.3のweb featureはFetchとWebの初期化を備え、URLとCryptoも有効にします。依存deno_fetch 0.237.0はBody methods、stream BodyInit、multipart / URL encoded、getSetCookieを実装しています。[Fetch初期化](https://docs.rs/crate/rustyscript/0.12.3/source/src/ext/web/init_fetch.js)、[Web初期化](https://docs.rs/crate/rustyscript/0.12.3/source/src/ext/web/init_web.js)、[Body](https://docs.rs/crate/deno_fetch/0.237.0/source/22_body.js)、[Headers](https://docs.rs/crate/deno_fetch/0.237.0/source/20_headers.js)

既定のsafe_extensionsはweb_stub、console、URL、Cryptoです。Request / Responseを使う構成ではweb featureを明示します。webにはHTTP / TLS / net / fsやimport経路も含まれるため、API提供と操作権限を別に構成します。既定のWebPermissionsは全許可で、AllowlistWebPermissionsも提供されます。[manifest](https://docs.rs/crate/rustyscript/0.12.3/source/Cargo.toml.orig)、[permissions](https://docs.rs/crate/rustyscript/0.12.3/source/src/ext/web/permissions.rs)

広い標準APIを使うprofileの候補です。Rust bridgeとの接続、起動時間、RSS、配布サイズを実際のアプリで比較します。

## Boa / boa_runtime / boa_wintertc

公開boa_runtime 0.22.0のRequestクラスはconstructorとcloneを登録します。Responseは文字列中心の本文とstatus / headers / text / json / bytesを提供し、BodyInitを文字列化します。URL.searchParamsは未実装エラーを返します。[Request](https://docs.rs/crate/boa_runtime/0.22.0/source/src/fetch/request.rs)、[Response](https://docs.rs/crate/boa_runtime/0.22.0/source/src/fetch/response.rs)、[URL](https://docs.rs/crate/boa_runtime/0.22.0/source/src/url.rs)

Headers.getSetCookie、Encoding、timer、clone、基本Abortを利用できます。Fetcherは明示的に登録し、ErrorFetcherでローカルな関連クラスを使えます。BlockingReqwestFetcherはblocking HTTPを実行します。[Headers](https://docs.rs/crate/boa_runtime/0.22.0/source/src/fetch/headers.rs)、[fetchers](https://docs.rs/crate/boa_runtime/0.22.0/source/src/fetch/fetchers.rs)

boa_wintertc 0.22.0はfetch / encoding / abort等に空のregister処理を含みます。組み込み時はboa_runtimeの具体的な登録内容を基準にします。[WinterTC fetch](https://docs.rs/crate/boa_wintertc/0.22.0/source/src/fetch/mod.rs)、[encoding](https://docs.rs/crate/boa_wintertc/0.22.0/source/src/encoding/mod.rs)

固定upstreamにはRequestのaccessor / body methods、URLSearchParams、ResponseのTypedArray対応が追加されています。Request.formDataはURL encodedをplain objectへ変換し、重複キーの最後が残ります。[Request](https://github.com/boa-dev/boa/blob/bea404d173bf74a64b7c7ae39b1bc2da639abeee/core/runtime/src/fetch/request.rs#L242)、[formData](https://github.com/boa-dev/boa/blob/bea404d173bf74a64b7c7ae39b1bc2da639abeee/core/runtime/src/fetch/request.rs#L298)、[Response](https://github.com/boa-dev/boa/blob/bea404d173bf74a64b7c7ae39b1bc2da639abeee/core/runtime/src/fetch/response.rs#L281)

Honoはdispatchでrequest.methodを使います。公開boa_runtime Requestへaccessor等を追加する必要がある、というのがソースからの推論です。一方、fetchlet共通profileを使うBoa構成では実fixtureを通過しています。[Hono dispatch](https://github.com/honojs/hono/blob/f6fbaf0299c48eea9e656e03e2ffe7ac755e8823/src/hono-base.ts#L498)

## frameworkの入口

Honoはapp.fetch(request)を使い、TSXはbuild時に変換します。必要なAPIはroute / middlewareに応じてRequest、Response、Headers、URL、Crypto、Streams等へ広がります。[Hono fetch](https://hono.dev/docs/api/hono#fetch)、[JSX](https://hono.dev/docs/guides/jsx)

SvelteKitはserver初期化にenv / read、respondにRequestを受け取りResponseを返します。固定版ではgenerateServerInstance等の入口を使います。[server](https://github.com/sveltejs/kit/blob/407ef8cb1257d0d7529db6ebde1130654ffd8fe4/packages/kit/src/runtime/server/index.js#L37)

renderはbytes / streamのResponse、respondはgetSetCookieを利用します。actions / uploadのFormDataとFile、内部fetch、assets、client address、platformもadapterへ接続する対象です。[render](https://github.com/sveltejs/kit/blob/407ef8cb1257d0d7529db6ebde1130654ffd8fe4/packages/kit/src/runtime/server/page/render.js#L636)、[respond](https://github.com/sveltejs/kit/blob/407ef8cb1257d0d7529db6ebde1130654ffd8fe4/packages/kit/src/runtime/server/respond.js#L565)

Cloudflare出力にはcloudflare:workers / ASSETS等のplatform依存があります。fetchletには専用adapterを用意し、Web標準のbuild出力を対象に統合します。Node固有APIは独立した互換性範囲として評価します。[Cloudflare worker](https://github.com/sveltejs/kit/blob/407ef8cb1257d0d7529db6ebde1130654ffd8fe4/packages/adapter-cloudflare/files/worker.js)

## 動作プローブ

23項目の[共通プローブ](../probes/README.md)を維持します。Deno CLI 2.9.8 / Node 26.13.1の参照実行、fetchlet profileによるQuickJS / Boa / V8の実行がそれぞれ23 / 23です。LLRT / rustyscript / boa_runtimeを直接組み込む構成は、次に同じprobeとfixtureで評価します。

[初回Deno結果](research/2026-11-16/probe-deno-reference.json)、[初回Node結果](research/2026-11-16/probe-node-reference.json)、[QuickJS](../results/web-api-quickjs.json)、[Boa](../results/web-api-boa.json)、[V8](../results/web-api-v8.json)
