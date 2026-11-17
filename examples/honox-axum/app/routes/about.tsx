import { createRoute } from "honox/factory";

export default createRoute((c) =>
  c.render(
    <main>
      <h1>About</h1>
      <p>fetchlet runs HonoX's SSR and islands inside axum.</p>
    </main>,
  ),
);
