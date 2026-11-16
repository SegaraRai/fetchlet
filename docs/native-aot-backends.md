# experimental AOTの調査

2026-11-16。Perry / scriptcでTS / JSをnative codeへ変換し、Rustへ組み込む構成を検証しています。関数実行を土台とし、利用可能な能力からFetch adapterへ広げます。

## 固定版の実測

Perry 0.5.1665 / scriptc 0.4.14で実行ファイルと静的ライブラリを生成しました。現在はPerry / scriptcのプレーン関数が成功しています。以前のprofileではPerry Hono JSXも成功し、Encoding更新後はutf-16beの初期化に互換性課題を確認しました。SvelteKitや通常のRust/MSVCリンクには、再現可能なcompiler / linkerの課題があります。

scriptc library → Rust no_std object + C main + Zig GNU CRTでは、Rustから初期化、add / multiply、小数計算を実行できました。この結果を同期ABIの足場にします。

実測と失敗理由は[実装・検証状況](implementation-status.md)、[AOT行列](../results/aot-matrix.json)、[native-link行列](../results/native-link-matrix.json)に記録しています。Appへの統合、文字列・バイト列・PromiseのRust境界は次の検証対象です。

## ライブラリ出力の契約

| compiler | 出力                               | 初期化・公開関数                         | 調査時の適用範囲                         |
| -------- | ---------------------------------- | ---------------------------------------- | ---------------------------------------- |
| Perry    | --output-type staticlib、.a / .lib | perry_module_initとnative hostの呼び出し | runtime / GCとのリンク、非同期駆動を検証 |
| scriptc  | build --lib --profile、.lib.a      | profileにentry、symbol、ABIを定義        | library modeは同期関数を対象にする       |

```text
perry compile app.ts --output-type staticlib -o libapp.a
scriptc build --lib --profile app.profile.json
```

scriptcはprofile内のentryを入力にします。program objectはmainを含む実行ファイル向けの形、library modeはhostから呼ぶ形です。library modeのPromise / async / timerは調査版の対応範囲外です。

[Perry出力形式](https://github.com/PerryTS/perry/blob/23c22f18bcc3b4e4cbaa430cfa19ebb855f140d8/docs/src/cli/flags.md#L155)、[scriptc library mode](https://github.com/vercel-labs/scriptc/blob/e9ed4826e324236da131b822867221f62c710db8/docs/content/docs/cli.mdx#L80)、[library対応範囲](https://github.com/vercel-labs/scriptc/blob/e9ed4826e324236da131b822867221f62c710db8/docs/content/limitations/browser-embedding.mdx#L5)、[native objects](https://scriptc.dev/docs/native-objects)

## fetchletへ接続するABI

```text
TS / JS → AOT compiler → native library
                           ↓
Rust App → runtime init → exported function → result / release
```

関数の型、compiler / runtime版、target、初期化と解放、所有権をartifactの契約に含めます。FetchにはURL、method、header pairs、本文bytesの境界を設け、library内でWeb Request / Responseへ変換します。

本文bytesと複数Set-Cookieを保持し、bufferの所有者、解放関数、有効期間を明示します。Promiseを扱うartifactには、開始、完了通知、event loop駆動とcancelのABIを設けます。同期関数と非同期Fetchは能力を個別に記録します。

同一processのAOTはnative codeとして評価します。第三者コードにはprocess / OS sandbox等の外側の強制を構成し、host serviceはbroker経由で提供する方針です。

## 先行例: Perry Coop

[Coop](https://github.com/PerryTS/coop/blob/efa8ada8ce186fa581bfbbc30ad99c7c1fbff97b/README.md)はRust hostがPerry製アプリ共有libraryを実行し、HTTPを処理する先行例です。

runtime / stdlibをproviderで共有し、compiler commit、provider hash、targetで同一性を確認します。HTTPはPerry Buffer上の独自COOP binary frame、handler規約はsidecarで識別します。[provider](https://github.com/PerryTS/coop/blob/efa8ada8ce186fa581bfbbc30ad99c7c1fbff97b/README.md#L137)、[host ABI](https://github.com/PerryTS/coop/blob/efa8ada8ce186fa581bfbbc30ad99c7c1fbff97b/docs/src/host-abi.md)

共有provider方式と単一実行ファイルへの静的リンクは、配布形態ごとに比較します。CoopのABIは参考候補として扱います。

## 次の検証

1. 通常のRust hostとのリンク、文字列とbinary、errorとreleaseを確認する。
2. PerryのPromise完了、host I/O、event loop、reuseとcancelを試す。
3. scriptcの同期HTML / data変換をlibrary modeで試す。
4. Hono / SvelteKitの実build出力を使い、言語機能、依存、Web APIを評価する。
5. VMと同じ応答を生成して、増分サイズ、起動時間、RSS、CPU時間、build時間を比較する。

AOTにも文字列、object、Promise、Web API、GC等のruntime費用があります。軽量さは同一アプリと同一負荷の測定で評価します。コード更新時の再compile / 再linkと、共有library更新時のABI管理も比較対象です。

## ソース調査の固定

| 対象    | upstream commit                          |
| ------- | ---------------------------------------- |
| Perry   | 23c22f18bcc3b4e4cbaa430cfa19ebb855f140d8 |
| scriptc | e9ed4826e324236da131b822867221f62c710db8 |
| Coop    | efa8ada8ce186fa581bfbbc30ad99c7c1fbff97b |

確認ファイルは[native-aot-sources.json](research/2026-11-16/native-aot-sources.json)に記録しました。upstream調査と固定配布版の実測を、それぞれの版に結び付けて参照します。

## 共通Web API更新後の実測

WPT導入とEncoding更新後の固定版行列は2成功・8失敗です。Perry / scriptcのplain関数が成功し、Perry Honoのmodule-sourceは新しいEncoding依存がnative TextDecoderでutf-16beを初期化する際に失敗します。以前の共通profileでのHono成功と、現在の依存構成を区別します。AOTごとのEncoding providerとmodule初期化順序の整備が次の課題です。現在の結果は[aot-matrix.json](../results/aot-matrix.json)、適合性基盤の範囲は[WPT / Test262](conformance.md)に記録しています。
