import { HttpStatusCode } from "@solidjs/start";

export default function NotFound() {
  return (
    <main>
      <HttpStatusCode code={404} />
      <h1>ページが見つかりません</h1>
    </main>
  );
}
