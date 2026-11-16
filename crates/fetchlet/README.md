# fetchlet

RustからJavaScriptの関数とFetchハンドラを呼び出します。Request / Responseと任意関数は同じ実行基盤で扱います。

## 共有handle

AppBuilder::spawn(WorkerOptions)は所有スレッドでAppを初期化し、複製可能なSend + SyncのAppHandleを返します。

```rust,ignore
use std::num::NonZeroUsize;
use fetchlet::{App, Backend, Module, WorkerOptions};

let options = WorkerOptions::new(NonZeroUsize::new(8).unwrap());
let app = App::builder(Backend::quickjs())
    .module(Module::new(bundle))
    .spawn(options)
    .await?;

let value = app.call_json("add", &[20.into(), 22.into()]).await?;
let response = app.fetch(request).await?;
app.shutdown().await?;
```

queue_capacityは待機中のコマンド数です。満杯の間は呼び出し側が非同期に待機します。実行は一つのApp内で直列です。native stackはWorkerOptionsで指定でき、既定はplatform設定です。

呼び出しFutureのdropで、その呼び出しをキャンセルします。中断・期限切れ・未完了処理で退役したInstanceは、次の呼び出し前に同じmodule / binding / 設定から再生成します。通常のJS例外の後は状態を再利用します。

shutdownは全cloneで新規受付を終了し、受付済み処理と資源回収の完了を待ちます。キュー容量待ちの呼び出しにはWorkerClosedを返します。最後のhandleをdropした場合も、所有スレッドは終了へ進みます。

Limitsの期限は実行開始からの協調的な期限です。待機を含む期限は、Rust側で呼び出しFuture全体へ適用できます。yieldしないJSと初期化時の強制停止はbackendごとの拡張対象です。

callはSerdeの単一引数、call_jsonはJSONの複数引数を扱います。fetch_with_contextはentryの第二引数へリクエスト固有情報を渡します。

## 所有スレッドで直接使う

AppBuilder::build()は呼び出し側が所有するAppを返します。&mut selfで直列呼び出しし、スレッド配置や寿命を自分で管理する用途に使います。

backendはquickjs、boa、v8から選択できます。Web APIと実行制御の範囲はrootのdocs、起動できるアプリはexamplesを参照してください。
