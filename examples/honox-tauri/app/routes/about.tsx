import { createRoute } from "honox/factory";

export default createRoute((c) =>
  c.render(
    <main>
      <h1>このページについて</h1>
      <p>HonoXのSSRとislandを、Tauriのプロセス内のfetchletで実行しています。</p>
    </main>,
  ),
);
