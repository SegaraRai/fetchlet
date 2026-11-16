# Rust配布物にWeb UIを組み込む

2026-11-16。製品の用途と配布上の目標をまとめます。コンセプトの基準は[プロジェクト方針](project-brief.md)、実装済みの範囲は[実装・検証状況](implementation-status.md)です。本書のTauri連携と配布統合は、今後検証する設計候補です。

## 提供する価値

fetchletは、選べるbackendでサーバーサイドJSを実行し、Rustアプリへ組み込む基盤です。frameworkのデータ取得、フォーム処理、動的なHTML / JSON生成までRustの配布物に持ち込み、RustのDBやアプリ状態と接続できる形を目指します。backendに合わせたWeb APIと必要なpolyfillの選択も、この使いやすさに含めます。

Rust APIとNode frontendを別サービスとして配置する構成は、それぞれの更新やスケーリングを独立させたいサービスに適しています。fetchletは、一つのRustプロセスと配布物にアプリをまとめたい場面を主な対象にします。実行時のJSは組み込んだengineが処理し、現在の開発・frontend buildにはNodeとVite+ / pnpmを使います。

SPAやSSGの静的ファイルをRustへ埋め込む構成でも、単一バイナリを提供できます。fetchletを選ぶ理由は、JS frameworkのサーバー側処理もRust側で動かし、Web版、CLI付属UI、デスクトップ版でページやアプリ処理を共有しやすくすることです。共有できる範囲はframeworkとplatform機能ごとに確認します。

## 主な用途

| 用途                   | 組み込みたい処理                                                         |
| ---------------------- | ------------------------------------------------------------------------ |
| CLIに付属するWeb UI    | CLIが開いたプロジェクト、実行結果、設定を反映したページとフォーム        |
| ローカルツール         | ローカルDBや検索indexを使う検索、ログ、差分、レポート、設定画面          |
| セルフホストアプリ     | RustのAPIとJS frameworkのサーバー側処理を一緒に配布・起動するアプリ      |
| Tauri連携の候補        | Rustのアプリ状態を使うページと、Web版で使っているserver-side処理の再利用 |
| pluginによる描画の候補 | 権限を限定したJSから動的ページやHTML断片を生成する拡張                   |

ページ中心のUIでは、起動時に選んだプロジェクトや設定、DBの結果をHTMLへ反映し、操作が必要な箇所にclient JSを使う構成が候補になります。SSRの適性は、ページの内容、操作モデル、初期化費用を含めて判断します。pluginの実行には、[権限と隔離](security.md)を用途に応じて構成します。

## Rustとの接続

主経路はRustがRequestを渡し、JSからResponseを回収する形です。逆向きには、frameworkのserver-side JSからfetchを使い、Rustのhandlerへ直接Requestを渡す経路を育てます。同じRequest / Responseの形で両方向を接続すると、framework側のデータ取得やフォームからRustの機能を利用しやすくなります。

この内部fetchはRust関数・routerをプロセス内で呼ぶ設計で、内部呼び出しのためのHTTP接続や待受ポートを追加せずに扱うことを目標にします。ブラウザーへ配信するHTTPサーバの待受は、利用するアプリが別途担当します。[プロセス内fetchの設計案](in-process-fetch.md)に、現在の土台と拡張案を分けて記載しています。

## Tauriとの関係

RustプロセスがJSのサーバー側処理を持ち、表示先としてブラウザー等を使う観点では「ヘッドレスTauri」に近い面があります。fetchletはサーバー側のJS実行とRustへの接続を担当し、ウィンドウやWebViewの管理はホストアプリの役割です。

Tauriの標準frontend構成は静的ホストとしてHTML / CSS / JSをWebViewへ提供し、SPA、SSG、通常のMPAを扱います。SSRを使う場合は、追加のサーバー側実行基盤を組み合わせる構成として検証します。[Frontend Configuration](https://v2.tauri.app/start/frontend/)

TauriのfrontendDistはディレクトリやファイル群の埋め込み、またはURL指定を扱います。fetchletで生成するHTMLとassetsをどうWebViewへ届けるかは、この読み込み経路と合わせて設計します。独自protocol等を使う案も含め、origin、CSP、Cookie、navigation、非同期応答、終了時の回収を確認する必要があります。[設定リファレンス](https://v2.tauri.app/reference/config/#frontenddist)

初期表示は静的HTMLやsplashscreenでも整えられます。SSRにはengine初期化と描画の費用があるため、起動高速化は計測する仮説として扱います。起動から最初の内容表示、操作可能になるまでの時間を、同じページの静的構成と比較します。[Splashscreen](https://v2.tauri.app/learn/splashscreen/)

## 単一バイナリへ向けた配布と寿命

| 項目              | 現在の土台                                                               | 次の統合・検証                                     |
| ----------------- | ------------------------------------------------------------------------ | -------------------------------------------------- |
| server-side JS    | Rustに組み込んだengineでbundleを実行                                     | backendごとの配布条件と起動費用の測定              |
| artifact          | server.js、client assets、fetchlet.jsonを生成                            | artifactと静的ファイルを埋め込み、配信する共通経路 |
| module供給        | Moduleがソース文字列を受け取る                                           | 埋め込んだartifactとmanifestの整合確認             |
| runnable examples | SvelteKit / Astro + axum。bundleをファイルから読み、assetsをディスク配信 | 外部buildディレクトリを使わない配布E2E             |
| lifecycle         | AppHandleの起動、キュー、cancel、shutdown                                | CLI・サーバ・WebViewの起動と終了への接続           |
| Tauri             | 接続方針を検討                                                           | WebViewへの応答経路とアプリ全体のE2E               |

単一バイナリ配布は統合目標です。現在の例はbuildディレクトリを利用します。配布を検証する際は、JS bundleとassetsに加え、engine、native library、OS側の実行条件を揃え、成果物全体のサイズを記録します。

使いやすさは、初回build、起動、初回表示、通常処理、cancel、終了までを通して評価します。配布サイズ、RSS、起動時間、同じ負荷での処理時間を測り、backendとpolyfillの選択に反映します。[polyfillの選択](../packages/build/README.md)と[資源予算](resource-policy.md)も、この配布・運用単位で構成します。
