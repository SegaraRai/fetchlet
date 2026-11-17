import { createRoute } from "honox/factory";
import Counter from "../islands/counter";
import Greeter from "../islands/greeter";

export default createRoute(async (c) => {
  const response = await c.env.RUST.fetch("https://rust.fetchlet.test/");
  const service = (await response.json()) as { message: string };
  const name = c.req.query("name") ?? "ゲスト";
  return c.render(
    <main>
      <h1>こんにちは、{name}</h1>
      <p data-message>{c.env.MESSAGE}</p>
      <p data-service>{service.message}</p>
      <Counter />
      <Greeter />
    </main>,
  );
});
