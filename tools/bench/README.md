# example benchmark

10の例のaxumサーバで、framework × JavaScript backend × endpointごとのreq/sを測ります。frameworkを使わない `bare` と、fetchletを通さずNodeで動かす `node` を比較の基準にします。

```bash
vp run bench
```

```bash
vp run bench -- --frameworks honox,waku --backends quickjs,v8 --endpoints ssr,context --duration-ms 5000
```

| 引数                            | 既定                           | 内容                                                                   |
| ------------------------------- | ------------------------------ | ---------------------------------------------------------------------- |
| `--frameworks`                  | `bare` と10例                  | `sveltekit`、`honox` など例の名前から `-axum` を除いた名前と `bare`    |
| `--backends`                    | `quickjs,boa,v8,node`          | artifactのbuildとRustのBackend。`node` は下の基準                      |
| `--endpoints`                   | `ssr,context,echo,rust,static` | 下の表                                                                 |
| `--connections`                 | 8                              | keep-aliveの同時接続数                                                 |
| `--warmup-ms` / `--duration-ms` | 2000 / 10000                   | 集計しない時間 / 集計する時間（endpointごと）                          |
| `--skip-build`                  |                                | 前回のrelease binaryと `.cache/bench` のartifactを使う                 |
| `--merge`                       |                                | 測った組み合わせだけ既存の結果の行を置き換える（接続数と時間は同じ値） |

## 測るもの

| endpoint  | request                                         | 経路                                        |
| --------- | ----------------------------------------------- | ------------------------------------------- |
| `ssr`     | `GET /?name=bench`（browserのUser-Agent）       | JSのSSR。RUST service bindingを1回呼ぶ      |
| `context` | `GET /api/context`                              | JSのJSON endpoint。request contextとbinding |
| `echo`    | `POST /api/echo`（JSON 35 bytes、`Origin`付き） | JSでrequest bodyを読んでJSONを返す          |
| `rust`    | `GET /api/rust`                                 | axumのhandler。JSを通らない基準             |
| `static`  | `GET /health.txt`                               | tower-httpのServeDir。JSを通らない基準      |

各組み合わせで次の手順を実行します。

1. `cargo build --release` で例のサーバを `boa` / `v8` featureつきでbuildします。
2. `FETCHLET_BACKEND=<backend>` で例のfrontendをbuildし、`fetchlet.json` のbackendを確認して `.cache/bench/<framework>/<backend>/build` へ複製します。最後に例の `build/` を既定のbackendで作り直します。
3. 例の `config.json` に `backend`、複製したbuild、`listen: 127.0.0.1:0` を設定してサーバを起動します。`queue_capacity` は接続数以上にします。
4. endpointごとに1回requestして2xxを確認してから、`fetchlet-bench` で負荷をかけます。

サーバは例と同じ構成です。tokioの `current_thread` runtimeでaxumが動き、1つのAppが1つのworker threadでrequestを順に実行します。`fetchlet-bench` は各接続で応答本文を読み終えてから次のrequestを送るclosed loopで、clientは2 threadのtokio runtimeです。req/sは集計時間内に完了した2xxの数、遅延は送信から本文の終わりまでです。

結果は `results/bench.json`（全数値）と `results/bench.md`（表）に書き、サーバのstderrを `.cache/bench/<framework>/<backend>/server.log` に残します。

## 基準

`bare`（[bare/app.ts](bare/app.ts)）は例と同じ `/`、`/api/context`、`/api/echo` を標準のRequest / Responseだけで実装したhandlerです。fetchletでは[build-artifact.ts](build-artifact.ts)が共通builderでartifactにし、HonoX例のRustサーバ（同じhost service）で動かします。

`node` は[node-server.ts](node-server.ts)がnode:httpで同じendpointを1 processで配信します。

- frameworkの行はv8向けartifactの `build/server.js` をNodeのmain contextで評価します。@fetchlet/runtimeは既存のglobalを保持するため、frameworkはNode自身のRequest、Response、Streams、timersで動きます。各frameworkの公式Node adapterではありません。
- `bare` の行はhandlerを直接importし、fetchletのbuildとruntimeを通しません。
- RUST bindingはprocess内でJSONを返します。`/api/rust` と `/health.txt` はaxumの経路に合わせたNodeの実装です。

## 読み方

- 1つのworkerがJSを直列に実行するため、JS endpointのreq/sはほぼ1 requestの実行時間の逆数です。接続数を増やすと遅延が伸び、req/sはほとんど変わりません。
- `rust` / `static` はaxumとclientの上限の目安で、JS endpointとの差がfetchletとframeworkの費用です。
- `bare` とframeworkの差がframeworkの費用、`bare` の `node` と各backendの差がfetchletの呼び出しとengineの費用です。
- client、サーバとOSが同じ機械を共有します。異なる機械の数値は比較しません。

## 呼び出しの内訳

`invoke` はHTTPを通さずにAppを直接呼び、1回のfetchを段階に分けて測ります。[probe/entry.ts](probe/entry.ts)をbackendごとにbuildしてから実行します。

```bash
node tools/bench/build-artifact.ts probe .cache/bench/probe/quickjs/build quickjs
```

```bash
node tools/workspace/cargo.ts run --release -p fetchlet-bench --bin invoke -- .cache/bench/probe --backends quickjs --iterations 3000
```

| 値                                                   | 内容                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------ |
| `js_us`                                              | JS内のloopで測った1回の時間。`url`、`request`、`wireResponse` など |
| `host_us.call_noop`                                  | 何もしないexportの汎用呼び出し                                     |
| `host_us.fetch_raw`                                  | Web APIのobjectを作らずwire objectを返すFetch entry                |
| `host_us.fetch_request_only` / `fetch_response_only` | Requestだけ / Responseだけを作るFetch entry                        |
| `host_us.fetch_context` / `fetch_echo` / `fetch_ssr` | bareのhandler                                                      |
| `host_us.worker_*`                                   | 同じ呼び出しをworker thread（HTTPサーバと同じ経路）で              |

同じ機械でも1回の実行は外れ値を含むことがあるため、複数回実行して比べます。

## host URL parserの効果

URLをcore-jsからhostの `url` crateへ移した変更を、同じ機械で比べた値です。`invoke` は2000回を2回ずつ、HTTPは同じartifactを差し替えて旧・新を2巡交互に5秒ずつ測った平均です。

| `invoke`（µs）          | QuickJS 旧 → 新   | V8 旧 → 新        |
| ----------------------- | ----------------- | ----------------- |
| `js_us.url`             | 53–63 → 6–7       | 16–25 → 4.4–4.6   |
| `js_us.request`         | 72–81 → 15        | 18–21 → 5.2       |
| `host_us.fetch_context` | 296–370 → 131–142 | 122–149 → 55–59   |
| `host_us.fetch_ssr`     | 507–646 → 266–272 | 243–246 → 124–129 |

HTTPのreq/sはbare、HonoX、SvelteKit、React Routerのssr / context / echoで、QuickJSが+23〜+138%、V8が+20〜+50%でした。最も大きいのはURLを複数回作るReact Routerのcontext（QuickJS 618 → 1468 req/s）です。`results/bench.json` の全行列はこの変更の前の計測です。
