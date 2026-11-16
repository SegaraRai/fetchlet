import { handle } from "../hono";

async function main() {
  const res = await handle({
    url: "https://fetchlet.invalid/hello/Rust",
    method: "GET",
    headers: [],
    body: null,
  });
  console.log(JSON.stringify(res));
}

main();
