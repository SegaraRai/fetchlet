import { add, transform, asyncValue } from "../functions";

async function main() {
  console.log(
    JSON.stringify({
      add: add(20, 22),
      transform: transform({
        name: "Rust",
        values: [1, 2, 3],
      }),
      async: await asyncValue("ok"),
    }),
  );
}

main();
