import { component$, Slot } from "@builder.io/qwik";
import { Link } from "@builder.io/qwik-city";

export default component$(() => (
  <>
    <nav>
      <Link href="/">ホーム</Link>
      <Link href="/about/">このページについて</Link>
    </nav>
    <Slot />
  </>
));
