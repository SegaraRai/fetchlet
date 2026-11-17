# How it works

## Rendering

SvelteKit renders the pages. Its server side runs on QuickJS inside the Rust process.

```ts
// web/lib/server/render.ts
const { data } = await rust.highlight({ body: { blocks } });
```

Rust's syntect highlights the code.

```rust
let html = highlighter.highlight(&block.code, &block.language);
```

## API

| Route                          | Caller         | Transport  |
| ------------------------------ | -------------- | ---------- |
| `https://rust.fetchlet.test/*` | Server-side JS | In-process |
| `/api/v1/*`                    | Browser        | HTTP       |

## Authority

Files outside the workspace cannot be opened. Paths that leave it through `..` or symbolic links are refused.
