import { fail } from "@sveltejs/kit";

import type { Actions, PageServerLoad } from "./$types";

// The in-process Rust API. Its origin is admitted by the Rust FetchPolicy, so
// both SvelteKit's `fetch` and `platform.env.RUST.fetch` reach it without a socket.
const API = "https://rust.fetchlet.test";

export const load: PageServerLoad = async ({ fetch }) => {
  // SvelteKit forwards other-origin requests from `event.fetch` to the global
  // `fetch`, which the Rust host routes to the same service.
  const response = await fetch(API + "/projects");
  return { projects: (await response.json()) as { id: number; name: string }[] };
};

export const actions: Actions = {
  default: async ({ request, platform }) => {
    const form = await request.formData();
    const name = form.get("name");
    const response = await platform!.env.RUST.fetch(API + "/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: typeof name === "string" ? name : "" }),
    });
    // HTTP errors from Rust are ordinary Responses.
    if (!response.ok) {
      const { error } = (await response.json()) as { error: string };
      return fail(response.status, { error });
    }
    return { created: (await response.json()) as { id: number; name: string } };
  },
};
