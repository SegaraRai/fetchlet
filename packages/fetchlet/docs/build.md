# fetchlet/build

frameworkのentryをfetchletの共通artifactへまとめます。Web API profile、選択したpolyfill、native能力の検査、frameworkの順に初期化します。

## backendに応じたpolyfill

```js
await buildArtifact({
  entry: "./server/entry.js",
  outDir: "./build",
  framework: "my-app",
  backend: "quickjs",
  requirements: ["Intl.DateTimeFormat"],
  intl: {
    locales: ["en", "ja"],
    timeZoneData: "golden",
  },
});
```

backendはquickjs / boa / v8 / portableです。Rustのbackendと合わせて選びます。既定のportableはnative Intlを前提にせず、不足時に補える実装を含めます。SvelteKitとAstroのadapterにもbackend / intlを同じ形で渡せます。

現在のIntl選択対象はgetCanonicalLocales、Locale、PluralRules、NumberFormat、DateTimeFormatです。アプリ固有の追加要求はrequirementsまたはintl.apisに、Intl.NumberFormatのような名前で指定します。frameworkの静的解析からAPI使用を推定する代わりに、adapterとアプリが要求を明示します。

| build backend | Intlの提供                            |
| ------------- | ------------------------------------- |
| quickjs / boa | 要求APIと依存APIのFormatJS polyfill   |
| v8            | native Intl。FormatJSをbundleから除外 |
| portable      | 要求APIの条件付きpolyfill             |

能力表はfetchletの既定engine構成を実測して固定し、3VMの回帰テストで照合します。将来のengine featureで能力が変わる際は、この表と同じ試験を更新します。v8向けartifactはアプリの評価前に要求するnative APIとlocaleを確認し、構成が合わない場合に再buildを案内します。ここでのAPI能力は上記の基礎機能で、ECMA-402の全提案や全optionの同一性は別途検証します。

## localeとタイムゾーン

intl.localesの既定値は["en"]です。選んだlocaleのデータだけをimportし、FormatJSが冗長な地域ファイルを省く場合は親localeのデータへ解決します。利用できる親データも無いlocaleはbuild時にエラーを返します。Intl.Locale等の共通メタデータと、formatterの選択localeデータはそれぞれの依存に従って入ります。

intl.timeZoneDataはutc（既定）/ golden / allです。utcはUTC用の基本実装、goldenはFormatJSの代表的なIANA timezone pack、allは全packを使います。polyfill側の既定timezoneはUTCです。golden / allでも、アプリからtimeZoneを明示すると実行ホストの既定値に依存せず表示できます。カレンダーは固定したFormatJS配布の基本範囲（Gregorian / ISO 8601）から扱います。追加カレンダーは別の選択・検証対象です。

localeとtimezone packはDateTimeFormat等のpolyfillを選んだ場合にbundleされます。v8ではnative ICUのデータを使います。CLDR / timezone更新により表示や過去・将来の時差が変わるため、依存更新時に実行結果を再確認します。

## framework向けの設定

| 設定                         | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `asyncContext: "serialized"` | `node:async_hooks` を、1つのinvocationの間だけstoreを保持する `AsyncLocalStorage` に置き換える。`run` はcallbackのPromiseが決着するまでstoreを保ち、`snapshot` / `bind` は全storageの値を捕捉する。各storageは決着していない `run` を開始順に持ち、最後に開始したものの値を返す。決着した `run` は順序に関係なく取り除かれるため、重なった `run` が開始と異なる順で決着しても、決着済みのstoreは残らない。Appはinvocationを直列に実行するため、invocation単位のcontextは正しく引き継がれる。1つのinvocation内で並行する `run` の間は、最後に開始した `run` のstoreが見える（分離はしない）。実装は `src/build/async-hooks.js`、試験は `vp run test:build` |
| `conditions`                 | 再bundleで追加するpackage解決の条件。frameworkが外部に残した依存を、`workerd` などの条件でWeb標準の入口へ解決する                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `plugins`                    | 再bundleに加えるRolldown plugin。vinextのNode APIの置き換えに使う                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `define`                     | `process.env.NODE_ENV` に加えて置き換えるglobal式                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

再bundleはRolldownで、依存をすべて含むIIFEのserver.jsを1つ出力します。entryは仮想moduleとして組み立て、ソースの隣に一時ファイルを作りません。`entry` にはmoduleのパスのほか、`{ source, resolveDir }` でソースを渡せます。importは `resolveDir` から解決します。各adapterはframeworkのserver buildへ接続するentryをこの方法で渡し、ディスクに書きません。adapterのshimも同名のnpm packageも提供しないNodeの組み込みmoduleは、Viteのbrowser buildと同じく空のmoduleになり、呼び出した箇所で失敗します。公開ファイルは各adapterがclient/へ置き、server.jsの隣には複製しません。HonoX、TanStack Start、SolidStart、Waku、vinextのadapterと、SvelteKit adapterの `rendering: "async"` が `asyncContext: "serialized"` を使います。

## 静的アセットのアーカイブ

`archiveArtifactAssets({ outDir, respond, routes })` は、artifactのclientディレクトリを `assets.flpk` にまとめ、`fetchlet.json` の `assets` に記録します。テキストはBrotli（品質11）で格納し、Rustの `AssetService` が `br` 対応クライアントへはそのまま、それ以外へは展開して返します。`respond(info)` は各パスの応答ヘッダーを `Headers` で返すか、`Response` で状態・ヘッダー・本文ごと置き換えます。各frameworkのadapterは `assets: true` で同じアーカイブを書き、ハッシュ付きのファイルにframeworkごとの `Cache-Control: immutable` を付けます。`.vite/` など `.` で始まるファイルとディレクトリは含めません。形式と応答の規則は[docs/asset-archive.md](../../../docs/asset-archive.md)にあります。

## artifactと検証

出力はserver.js、client/への参照、fetchlet.jsonです。client assetsの生成は各framework adapterが担当します。manifestにはbackend、要求API、native前提、実際に選んだpolyfill / moduleとlocale・timezoneの設定を保存します。RustのModuleは現在ソースを受け取るため、これらのmetadataを用いるRust側の自動選択は次の統合対象です。

共通Web API層は引き続き全backendで共有します。Intlから始めた選択方式を、その能力表と適合試験を整えながら他のpolyfillにも広げます。native APIの有無による選択と、I/Oの権限・資源所有権は別の責務として保ちます。

```powershell
vp run test:polyfills
```

API依存、locale選択、日本語・Tokyoの表示、native constructorの保持、V8向けのFormatJS module除外、能力不一致を確認します。実測のmoduleとbundle bytesは[polyfill-matrix.json](../../results/polyfill-matrix.json)に保存します。

依存とデータの読み込み順はFormatJSの[NumberFormat](https://formatjs.github.io/docs/polyfills/intl-numberformat/)と[DateTimeFormat](https://formatjs.github.io/docs/polyfills/intl-datetimeformat/)の要件を参照しています。

embedded向けのpackage解決はmodule / production条件とmodule / main入口を使います。ブラウザーのnative APIを前提とする入口とNode専用入口を選ばず、組み込みengineで使えるJS実装へ解決するための設定です。
