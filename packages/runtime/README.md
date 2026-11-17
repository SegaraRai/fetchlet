# @fetchlet/runtime

framework adapterが使う共通Web API profileとFetch entryの接続を提供します。現在はworkspace内の初期パッケージです。

`@fetchlet/runtime/adapter` の `createFetchHandler` は、標準Request / Responseを扱う関数とRustのwire形式を接続します。第二引数のcontextは呼び出し単位の値です。任意関数も同じbundleからexportできます。

```ts
import { createFetchHandler } from "@fetchlet/runtime/adapter";

export const handle = createFetchHandler(async (request: Request, context: { name: string }) => {
  return new Response("Hello, " + context.name);
});

export function add(left: number, right: number) {
  return left + right;
}
```

`getBindings<T>()` はRustが固定したenv / serviceを返します。JSのfetchはRustのhost serviceへ中継します。Web API profileの適合範囲と検証はrootの `docs/implementation-status.md` を参照してください。

## profileとprovider

Web API初期化を伴う接続は@fetchlet/runtime/adapterを使います。共通builderが先にprofileを初期化するframework統合では、副作用のない@fetchlet/runtime/handlerを使えます。Astroの中間SSR buildへNode専用のpolyfillを取り込まず、最終embedded buildでproviderを一度だけ選ぶための境界です。

Encodingは@exodus/bytes/encoding-lite.jsを使い、UTF-8、UTF-16とsingle-byte encoding、TextEncoderStream / TextDecoderStreamを提供します。legacy multi-byte encodingは追加profileの対象です。native Encodingがある環境は既存APIを保持します。

Streamsはweb-streams-polyfill 4.5.1へ固定します。FetchのbodyUsedはStreams内部のdisturbed状態を必要とするため、stream-state.tsの専用seamでこのproviderの状態を参照します。provider更新時は直接reader、cancel、clone / teeの適合・回帰試験と合わせてこのseamを検証します。異なるStreams providerとの接続は対応するadapterを設計して評価します。

URLはfetchlet hostの `url` crate（WHATWG URL Standard）で解析します。constructor、`URL.parse` / `URL.canParse` と各setterが `url.parse` / `url.set` のhost操作を一回呼び、返った全componentを保持するため、getterはbridgeを渡りません。`searchParams` はprofileのURLSearchParamsで、URL Standardのとおり双方向に連動します。host操作の入力と応答は呼び出しの `bridge_message_bytes` に従います。`__fetchletHost` を持たないhost（Node等）はcore-jsのURLを使い、native URLがある環境は既存APIを保持します。URLSearchParamsは全hostでcore-jsです。

文字列、BufferSource、URLSearchParamsで作ったRequest / Responseの本文は、`body` を参照するまでbytesのまま保持します。arrayBuffer() / bytes() / text() / json() / formData() / clone() はstreamを作らずにこのbytesを使い、読み終えた本文の `body` はdisturbedでlockされたstreamを返します。`body` を参照した後はFetchのbyte streamとして扱います。Fetch entryの応答がbytesのままなら、wire形式へstreamを経由せず渡します。

Blob.streamはtransfer能力がある環境でbyte stream、現在のBoa profileでは通常のstreamを返します。本文のRustとの受け渡しはbufferedで、サイズ・コピー・資源管理と双方向streamingは引き続き拡張対象です。

[WPT / Test262と既知差分](../../docs/conformance.md)に、実際の試験範囲をまとめています。
