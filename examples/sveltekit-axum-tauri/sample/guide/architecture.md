# しくみ

## Rendering

ページは SvelteKit が描画します。SvelteKit のサーバー側は Rust プロセスの中の QuickJS で動きます。

```ts
// web/lib/server/render.ts
const { data } = await rust.highlight({ body: { blocks } });
```

コードのハイライトは Rust の syntect が担当します。

```rust
let html = highlighter.highlight(&block.code, &block.language);
```

## API

| 経路                           | 呼び出し元    | 通信       |
| ------------------------------ | ------------- | ---------- |
| `https://rust.fetchlet.test/*` | サーバー側 JS | プロセス内 |
| `/api/v1/*`                    | ブラウザー    | HTTP       |

## 権限

ワークスペースの外のファイルは開けません。`..` やシンボリック リンクで外へ出るパスは拒否されます。
