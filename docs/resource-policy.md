# 資源予算と実装上の上限

2026-11-16。値の所有者と根拠を区別し、運用ポリシーを呼び出し側で設定できる構成に整理しました。

## 呼び出し側が選ぶ予算

`Limits` の各項目は `Option` です。`Some(value)` で有効にし、`None` はホストへ管理を委ねます。既定値はすべて `None` です。必要な値は、アプリの入力、SSR出力、上流service、並列数、process全体の容量を計測して決めます。

| 項目                 | 単位・適用箇所                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| timeout              | 一回のApp呼び出し（streaming本文の完了まで）、またはRustから直接使うFetchServiceの協調的な経過時間 |
| request_body_bytes   | 個々の入力Request・外向きRequest本文のバイト数                                                     |
| request_body_chunks  | JSから外向きRequest本文を読むときのchunk数。空chunkも数える                                        |
| response_body_bytes  | 個々の出力Response・上流Response本文のバイト数。streaming本文は累積で検査                          |
| header_bytes         | 個々のheader集合の名前・値の合計バイト数                                                           |
| url_bytes            | 入力Requestおよび書き換え後の送信先URLのバイト数                                                   |
| bridge_message_bytes | native callbackへ渡す個々のJSON入力messageのバイト数                                               |
| digest_bytes         | SHA-256へ渡す入力バイト数                                                                          |
| subrequests          | 一回のInvocationで開始を試みるhost fetch数。失敗・中断でも消費を保持                               |
| redirects            | 一回のfetchで追うredirect数。Fetchの仕様上限の範囲で適用                                           |

`Some(0)` はゼロの予算です。timeoutでは呼び出し開始前の期限切れになります。Bodyの `collect(limit)` に渡す値も呼び出し側の予算です。

`WorkerOptions::response_body_queue` はworkerがJSから先読みするstreaming本文のchunk数です。既定1で、consumerの読み取りに合わせて生成します。JS側で1回のpullにまとめるchunkの64 KiBはbackpressureの粒度で、本文の予算ではありません。

本文、headers、messageの検査は個々の境界に適用します。JSON変換・buffering前後のコピーやエンジン全体のheap使用量は別に管理します。yieldしないJSと初期化時の実行には、エンジンの割り込みや外部process管理による強制が必要です。

## 既存の固定値の見直し

| 以前の設定                                        | 現在の扱い                                 | 判断の理由                                      |
| ------------------------------------------------- | ------------------------------------------ | ----------------------------------------------- |
| Appの5秒、backendの10秒                           | 任意のtimeoutをAppで一元管理               | 用途ごとの応答時間とホストのdeadlineに合わせる  |
| 本文1 MiB、headers64 KiB、message8 MiB、URL16 KiB | 個別の任意予算                             | 対象アプリの実測を根拠に選ぶ値                  |
| subrequest16回、redirect5回、chunk16,384個        | 個別の任意予算                             | 呼び出し側の処理内容と通信policyに属する値      |
| digest1 MiB                                       | digest_bytesで設定                         | SHA-256入力の運用予算として扱う                 |
| timeout最大1時間等の設定値上限                    | 型・platformで表現できる値を受付           | 一律の実装上限にする根拠がなかった              |
| binding数128、名前128文字、値64 KiB               | 呼び出し側がbindingを構成                  | trustedな構成入力。重複名は構成エラーとして検査 |
| QuickJS heap256 MiB / stack2 MiB                  | QuickJsOptionsの明示設定、既定はengine設定 | エンジン固有の資源方針として扱う                |
| V8 worker stack16 MiB                             | V8Optionsの明示設定、既定はplatform設定    | 使用するbundleとplatformに合わせる              |
| loopの1〜10 ms待機                                | Futureの通知とJS timer時刻で駆動           | 非同期処理の完了と次の実行時刻に応じて起床する  |

QuickJSのheap / stackとV8 worker stackを明示する場合は正の値を指定します。予算の有効性は各エンジン・OSが提供する範囲に従います。

## 仕様・容量に由来する境界

| 境界                          | 根拠・扱い                                                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| getRandomValuesの65,536バイト | [Web Cryptoのquota](https://www.w3.org/TR/webcrypto-2/#Crypto-method-getRandomValues)。仕様に従う固定値                          |
| redirect20回                  | [FetchのHTTP-redirectアルゴリズム](https://fetch.spec.whatwg.org/#http-redirect-fetch)。呼び出し側はさらに小さい予算を指定できる |
| usize / u64、時計の表現範囲   | checked arithmeticとtimeout構成検査で扱う                                                                                        |
| http::HeaderMapやengineの容量 | 依存ライブラリの容量に従い、可能な境界ではエラーへ変換する                                                                       |

これらは運用上の推奨予算とは別の根拠を持ちます。たとえば20回のredirectはFetchの互換性条件であり、上流APIに適した回数は呼び出し側が選びます。

## 確認方法

以前の1 MiBを超える本文往復、1時間を超えるtimeout構成、任意のmessage / subrequest予算、仕様上限で終了するredirect、pending Futureからの起床を回帰テストで確認します。framework行列ではengine固有オプションの既定値でHono／SvelteKitを動かします。

実運用の推奨値は、同一アプリ・同一負荷で起動時間、RSS、処理時間、同時実行数を測った後に提示します。
