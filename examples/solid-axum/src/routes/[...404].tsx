import type { RouteDefinition } from "@solidjs/router";
import { httpStatus } from "@solidjs/web";

// Sets the status before the response head flushes.
export const route = {
  preload: () => httpStatus(404),
} satisfies RouteDefinition;

export default function NotFound() {
  return (
    <main>
      <h1>Page not found</h1>
    </main>
  );
}
