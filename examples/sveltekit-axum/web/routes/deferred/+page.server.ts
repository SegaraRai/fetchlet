import type { PageServerLoad } from "./$types";

// A promise returned without awaiting streams after the page.
export const load: PageServerLoad = () => ({
  slow: new Promise<string>((resolve) =>
    setTimeout(() => resolve("A value that arrived late"), 200),
  ),
});
