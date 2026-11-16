import { createRoute } from "honox/factory";

export default createRoute((c) =>
  c.render(
    <main>
      <h1>このページについて</h1>
      <p>HonoXのSSRとislandを、axumの中のfetchletで実行しています。</p>
    </main>,
  ),
);
