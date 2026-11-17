# Web APIとECMAScriptの適合性評価

2026-11-16。WPT、Test262、fetchlet独自の回帰試験を、Node参照とQuickJS / Boa / V8へ同じ入力で実行します。ここで扱う範囲は固定した選定テストです。API全体や上流suite全体の適合率は、対象をさらに広げて評価します。

## 評価する層

| 試験           | 対象                                                                  | 現在の選定                                                                        |
| -------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| WPT            | Fetch、Headers、Blob、FormData、Encoding、Abort、StreamsのWeb API動作 | 80ファイル、各構成1266 subtest                                                    |
| Test262        | engineのECMAScript動作                                                | Array.prototype.at、Promise.resolve、throwの44ファイル。strict / sloppyで88ケース |
| 独自回帰       | 発見済み不具合の再現と修正                                            | Body、所有権、validation、Blob、FormData、Encodingの15件                          |
| runner自己試験 | テストを評価する基盤の正しさ                                          | assertion失敗、async完了、mode、global code、期待値、timeout等の8件               |

framework E2E、RustのHTTP変換、権限、streamingのbackpressure、host境界のfuzzingは、それぞれ別の試験を維持します。[実装状況](implementation-status.md)と[安全性](security.md)を併せて参照してください。

## 原本と固定版

上流の原本、公式harness、参照するMETA script / Test262 includes、ライセンスを[upstream](../tests/conformance/upstream/)へ保存しています。[sources.lock.json](../tests/conformance/sources.lock.json)に選定パス、repository、commitと全ファイルのSHA-256を記録し、毎回検証します。原本へはformatterやassertionの変更を適用せず、fetchlet側の実装とrunnerで対応します。

- WPT: [c43f14b481a9960c6bc553c68e2e489bf6f95ac9](https://github.com/web-platform-tests/wpt/tree/c43f14b481a9960c6bc553c68e2e489bf6f95ac9)
- Test262: [2e58f87d8350ad51224617a041c6e041d52f8444](https://github.com/tc39/test262/tree/2e58f87d8350ad51224617a041c6e041d52f8444)

取り込む版を更新するtoolは、既知の公式repositoryからソースを取得して保存します。その処理中に上流コードやinstall scriptを実行する経路はありません。更新後に原本とライセンスの差分をレビューしてから試験します。

## 実行

プロジェクトルートから実行します。

```powershell
vp run test:conformance:runner
vp run test:conformance
```

Rustのlab binaryを全backendでbuildした後、各ファイル・mode・backendを新しいprocess / realmで評価します。Nodeはnative Web APIの参照、3VMはfetchletのWeb API profileを使います。Test262にはWeb API bundleを注入せず、engineとfetchletの基本host環境を使います。

結果は[conformance.json](../results/conformance.json)です。原本のcommit、lockfile / profileのhash、Node / platform、試験名、実測status、診断、期待値との一致を保存します。fileDurationMsはファイル全体の実行時間で、個別assertionの時間とは区別します。

絞り込みと厳密評価は、binaryのbuild後に次のように実行できます。

```powershell
node tools/conformance/cli.ts --suite wpt --backend quickjs --filter Blob --output results/conformance-blob.json
node tools/conformance/cli.ts --suite test262 --backend quickjs,boa,v8 --output results/conformance-test262.json
node tools/conformance/cli.ts --strict --output results/conformance-strict.json
```

suiteはwpt / test262 / regressions / allです。filterはファイルパスの部分一致です。timeoutはprocessごとのミリ秒（既定30000）、jobsは同時実行数（既定2）で、各CLI optionで変更できます。実行ごとに生成先を分け、同時に走る試験の入力を独立させています。outputを変えると絞り込み結果と全体結果を併存できます。

## 結果と回帰判定

| 実測status                   | 扱い                                                           |
| ---------------------------- | -------------------------------------------------------------- |
| pass                         | 試験の成功                                                     |
| fail                         | assertionやTest262 scriptの失敗。既知の場合も失敗件数へ計上    |
| unsupported                  | runnerが対応するmode・host機能の範囲外。成功件数とは分けて表示 |
| timeout                      | 親processが期限で終了。回帰チェックのエラー                    |
| harness-error / runner-error | harnessの異常、実行失敗等。回帰チェックのエラー                |

[expectations.json](../tests/conformance/expectations.json)はbackend・ファイル・mode・subtest名ごとに、レビューした既知失敗と理由を持ちます。通常の終了コード0は「記録した既知差分と一致」という意味です。既知失敗はfailのまま残し、expectedFailuresにも計上します。

新規失敗、timeout、harness / runnerのエラー、期待していた失敗の成功化を終了コード1で通知します。全体実行では消えた期待値も検出します。改善時は試験を確認して該当expectationを外します。strictでは、既知失敗も含めて一件でも失敗があれば終了コード1にします。

明示的に全行列の期待値を再記録するoptionは--record-baseline "レビュー理由"です。更新後も個々の理由を具体化し、差分をレビューします。runnerのエラーや独自回帰試験の失敗を期待値へ取り込む操作は拒否します。通常のCIは期待値を書き換えず照合します。

## 現在の実測と既知差分

Windowsローカル、固定版と選定範囲での実測です。

| 構成     | WPT 成功 / 失敗 | Test262 成功 / 失敗 | 独自回帰 成功 / 失敗 |
| -------- | --------------- | ------------------- | -------------------- |
| QuickJS  | 1210 / 241      | 88 / 0              | 22 / 0               |
| Boa      | 1210 / 241      | 88 / 0              | 22 / 0               |
| V8       | 1281 / 170      | 88 / 0              | 22 / 0               |
| Node参照 | 1278 / 173      | 88 / 0              | 22 / 0               |

WPTは86ファイル、各構成1451 subtestです。失敗はすべて[expectations.json](../tests/conformance/expectations.json)で分類と理由を記録した既知差分で、新規失敗は0件です。分類ごとの件数（QuickJS / Boa / V8 / Node）と範囲は次のとおりです。

| 分類                 | 件数                  | 対象と理由                                                                                                                                                                                                                                                        |
| -------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| server-profile       | 145 / 145 / 145 / 143 | 文書の基準URLに対する相対URLの解決（`new Request("")`等）。サーバーprofileはglobalな基準URLを持たず、サーバー側の相対URLはframework adapterが受信Requestから解決します（[設計](in-process-fetch.md)）。Node参照も同じく失敗。Set-Cookieのresponse guardもこの分類 |
| host-capability      | 22 / 22 / 22 / 22     | WPT HTTP serverのresourceをfetchする試験と、MessageChannel。外向きfetchはRustのhost行列で検証しています                                                                                                                                                           |
| backend-capability   | 71 / 71 / 0 / 0       | QuickJS / BoaのSharedArrayBuffer非公開（ArrayBuffer版は成功）                                                                                                                                                                                                     |
| profile-selection    | 2 / 2 / 2 / 0         | encoding-liteはUTF-8 / UTF-16 / single-byteを提供し、legacy multi-byte decoderを含めない構成                                                                                                                                                                      |
| upstream-comparison  | 1 / 1 / 1 / 1         | 空FormDataの本文にmultipart終端を出力。空文字列を期待する固定WPTと差があり、Node参照も失敗                                                                                                                                                                        |
| reference-difference | 0 / 0 / 0 / 7         | Node参照のTextDecoderの終端処理の差と、undiciの本文読み取りが改変した`Object.prototype.then`から観測できる差                                                                                                                                                      |

### 選定と除外

86ファイルはFetch（Headers / Request / Response / Body）、FileAPI（Blob / File）、FormData、Encoding、DOM Abort、Streams（constructor、tee、cancel、async iterator、default reader、byte streamのtee）です。WPT serverを前提とするファイル（header-values、json、response-cancel-stream、response-headers-guard）は選定外です。request-disturbed / request-structure / request-keepaliveはtop-levelで相対URLのRequestを生成し、ファイル全体がrunner-errorになるため除外しています。Request属性のWeb IDLは独自回帰で検証しています。encodeInto-tail-unmodifiedは6万回超の反復を行う試験で、Boaのdebug buildがprocess期限30秒を超えるため除外し、同じ範囲をencodeInto.any.jsで評価しています。

### この選定で修正した動作

- AbortSignal.abort / timeout / any、dependent signalの中断順序、onabort、listenerの重複排除とonce、既定reasonのDOMException（AbortError / TimeoutError）。DOMExceptionはcore-js-pureで補います
- Body / BlobのtextStream()、文字列・ArrayBuffer・URLSearchParams本文のbyte stream化（BYOB）、clone時の第2分岐へのstructuredClone
- formData()が型判定より先に本文を読み、streamのエラーを伝播
- Headersのrecord変換順序とSymbolキーの拒否、File / FormData constructorの引数検証、constructor名、FormDataでのlastModified保持
- BoaでArrayBuffer transferを提供し、Body / BlobのBYOBとbyte streamのteeを全VMで有効化（Boa 0.22は`experimental` featureの背後に置くため、backendが `transfer` / `transferToFixedLength` / `detached` を補います。resizable bufferは固定長として転送）
- Streams providerのasync iteratorを%AsyncIteratorPrototype%へ接続
- 本文の全量読み取りをpipeToの内部read requestで行い、改変した`Object.prototype.then`から本文を観測・置換できない構成へ変更
- multipart/form-dataをbyte単位で解析。行頭の区切りのみ認識し、preamble / epilogue、大小文字を区別しないMIME型と引数、quoted boundary、UTF-8と%0D / %0A / %22のescapeを扱い、不正な区切り・header・未終端をTypeErrorにする
- Requestの属性（mode、credentials、cache、referrer、referrerPolicy、integrity、keepalive、duplex等）を読み取り専用のprototype accessorとして公開し、RequestInitのenumerationとonly-if-cachedの制約を検証

### URL

fetchlet hostのURLは `url` crate 2.5.8で解析します。`vp run test:url` は、そのcrateが同梱するWPTのurltestdata.json（constructor）とsetters_tests.json（setter）を各backendで実行し、失敗がcrateのtests/expected_failures.txtの範囲内であることを判定します。結果は[url-wpt.json](../results/url-wpt.json)に記録します。

| 構成     | 成功 / 全体 | expected_failures.txt外の失敗 |
| -------- | ----------- | ----------------------------- |
| QuickJS  | 1027 / 1073 | 0                             |
| Boa      | 1027 / 1073 | 0                             |
| V8       | 1027 / 1073 | 0                             |
| Node参照 | 1052 / 1073 | 参考値（Nodeのparser）        |

残る46件は `url` crateの既知差分で、file URLのhost・空のpath segment・Windows drive letterの扱いと、特殊でないschemeで `/.//` のようなpathを伴うparse / setterです。以前のcore-js URLは同じデータで1007 / 1073でした。blob: URLのoriginはcrateの `quirks::origin` が現行仕様より前の動作のため、内側のURLがhttp(s)の場合だけそのoriginを返すようhostで補います。URLのIDL accessor、`searchParams` の双方向連動、lone surrogateの置換は独自回帰で検証し、`url.parse` / `url.set` はbridge_bodies fuzz targetが任意の入力で呼び出します。

CIにWindows / Linuxのrunner自己試験と適合性行列を組み込んでいます。remote CIの実行結果は、今後その環境で確認します。

## 実行環境の範囲

WPTは公式testharness.jsのshell環境を使い、selfをglobal objectへ接続します。META scriptを元の相対パスで解決し、scriptとして評価します。Window / DOM、実HTTP server、WebDriver、reftest等は、それぞれ対応する実行環境を加える対象です。GC関連の原本は上流のbest-effort helperを使い、強制GCの成立は現在の結果に含めません。

Test262は、ファイルごとのflags、includes、strict / sloppy、asyncの公式$DONEを扱います。harnessとtestをネイティブglobal scriptとして評価し、top-level lexical bindingを維持します。現在の$262はglobalを提供します。module、raw、例外のphaseと型を照合するnegative試験はunsupportedを記録します。agent、別realm生成、明示的detach / GC等のhost依存は、各試験のmetadataとharnessを確認してhost対応とともに選定を広げます。現在の$262にはそれらの代替実装を設けず、選定したpositive scriptが不足するhost機能を呼んで失敗した場合は実測failとして記録します。新しい構文やbuiltinの不足によるpositive scriptの失敗は、実測failとして扱います。

## テストを増やす

固定commitを明示して、選定ファイルを追加・削除できます。更新toolは依存script / includesも取得し、全原本のhashを再記録します。

```powershell
node tools/conformance/update-sources.ts --suite wpt --revision <40桁のcommit> --add fetch/api/response/response-clone.any.js
node tools/conformance/update-sources.ts --suite test262 --revision <40桁のcommit> --add test/built-ins/Array/prototype/at/returns-item.js
vp run test:conformance:runner
vp run test:conformance
```

--addと--removeは複数指定できます。WPTの選定は現在.any.js、Test262はtest/配下の.jsを扱います。各テストが必要とする環境とmetadataを読んで選定し、評価可能な範囲を文書と結果へ反映します。

同じ固定版の原本を復元するにはvp run fetch:conformanceを使います。ネットワーク取得後も記録済みSHA-256を検証します。--removeは選定とlockから外し、展開済みの原本ファイルは残すため、不要になった原本は手動で削除します。

upstream/はvite.config.tsのfmt.ignorePatternsで整形対象から外しています。原本がformatterで書き換わるとchecksum検証で停止します。その場合はconformance:restoreで復元します。

## 次に広げる範囲

Test262のhost機能とnegative / module試験、Streamsのwritable / transform / piping、Requestのno-corsのheader guardへ順に広げます。Request属性のうちreferrerは環境のoriginを持たないため、URLを解析した値を保持します（Node参照と同じ扱い）。以前の修正は、Bodyのdisturbed状態、byte bodyのsnapshot、constructor / static method検証、HeadersとFormDataのlive iteration、Blobのslice / bytes、UTF-8 / BOM等を回帰試験へ結び付けています。

Rustまで含むストリーミングと、JS側multipart / Bodyのfuzzingはそれぞれ追加の検証経路を整えます。現在のRust host境界のfuzzingと、Web API適合試験は対象を分けて維持します。

## AOTとの対応

現在の適合性runnerはVMのScript / Promise境界を使います。AOT compilerには同じテストを個別にcompileして結果を返すadapterを追加する段階で接続します。AOT行列は既存の別経路で継続します。今回のEncoding更新後はPerry / scriptcのplain関数が成功し、Perry Honoはutf-16beのnative TextDecoder初期化で失敗しました。VMのWeb API適合性改善と、AOT固有のprovider選択を分けて記録します。[AOTの現在の実測](native-aot-backends.md)を参照してください。
