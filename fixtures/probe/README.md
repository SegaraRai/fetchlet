# Web APIの共通プローブ

`web-api.js` は23項目のローカルな動作を確認します。バイナリ本文、Bodyの消費、Cookieの多値、FormData、Streams、cancel、Encoding、Abort、microtask / timer、clone、Crypto、synthetic handlerを検査します。

## 参照実行

依存追加の作業を伴わず、プロジェクトルートから実行できます。

```powershell
deno run --no-config --no-lock fixtures/probe/run.ts
node fixtures/probe/run.ts
```

Deno CLIとNodeはプローブの参照環境です。組み込みbackendの結果は、各エンジンとWeb API profileを初期化した実行で記録します。

## 組み込み実行

```powershell
vp run build:fixtures
vp run test:rust
vp run test:matrix
```

QuickJS / Boa / V8とfetchlet共通profileの結果を `results/web-api-{backend}.json` に保存します。構成と依存版は[実装・検証状況](../docs/implementation-status.md)を参照してください。

別のprofileを評価するときは、Web APIとhost機能を初期化し、スクリプトを評価して `globalThis.fetchletProbe({ runtimeLabel })` のPromiseをホスト側で駆動します。

各checkは可能な環境で2秒のテスト用timeoutを使います。実行基盤全体の停止はホスト側のdeadlineで監視します。このプローブの評価範囲は23の動作です。実HTTP通信、Rust Bodyのbackpressure、API全体の仕様適合は、それぞれ専用の試験へ広げます。
