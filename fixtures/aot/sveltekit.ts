import { handle } from "../sveltekit/entry";

async function main() {
  const res = await handle({
    url: "https://fetchlet.invalid/?name=Rust",
    method: "GET",
    headers: [],
    body: null,
  });
  console.log(JSON.stringify(res));
}

main();
