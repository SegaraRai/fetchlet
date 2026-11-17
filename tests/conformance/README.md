# Conformance sources and regressions

実行方法、modeの範囲、既知差分は[適合性評価](../../docs/conformance.md)を参照してください。

| ファイル          | 役割                                            |
| ----------------- | ----------------------------------------------- |
| sources.lock.json | 選定した上流テスト、固定commit、全原本のSHA-256 |
| upstream/wpt/     | WPTの原本と公式testharness、support、LICENSE.md |
| upstream/test262/ | Test262の原本と公式harness、LICENSE、解釈規則   |
| expectations.json | 個別にレビューした既知失敗と理由                |
| regressions/      | fetchletで発見・修正した不具合の独立回帰試験    |

上流の原本は取得したbytesを維持します。formatterの対象はfetchlet側のrunnerとregressionsです。新しい試験は、その試験が必要とするhost機能、META script / includes、適用modeを確認してから選定へ追加します。原本の更新はtools/conformance/update-sources.ts、記録した版の復元はvp run fetch:conformanceで行います。
