import { component$, Slot } from "@builder.io/qwik";
import { Link } from "@builder.io/qwik-city";

export default component$(() => (
  <>
    <nav>
      <Link href="/">Home</Link>
      <Link href="/about/">About</Link>
    </nav>
    <Slot />
  </>
));
