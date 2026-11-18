import { error, json } from "@sveltejs/kit";

import type { RequestHandler } from "./$types";

const API = "https://rust.fetchlet.test";

// How a rejected fetch looks to the application.
function describe(reason: unknown) {
  const value = reason as { name?: string; code?: string; message?: string };
  return { name: value.name, code: value.code, message: value.message };
}

async function outcome(request: () => Promise<Response>) {
  try {
    const response = await request();
    return { status: response.status, body: await response.json() };
  } catch (reason) {
    return { rejected: describe(reason) };
  }
}

export const GET: RequestHandler = async ({ params, fetch, platform }) => {
  switch (params.case) {
    // A Rust 500 is a Response, not a rejection.
    case "failure":
      return json(await outcome(() => platform!.env.RUST.fetch(API + "/failure")));
    // The Rust Context identifies the caller; a header JavaScript sets does not.
    case "caller":
      return json(
        await outcome(() =>
          platform!.env.RUST.fetch(API + "/caller", {
            headers: { "x-forwarded-for": "203.0.113.9" },
          }),
        ),
      );
    // The FetchPolicy admits only the Rust API's origin.
    case "denied":
      return json({
        binding: await outcome(() => platform!.env.RUST.fetch("https://example.com/")),
        global: await outcome(() => globalThis.fetch("https://example.com/")),
        event: await outcome(() => fetch("https://example.com/")),
      });
    // Aborting drops the Rust handler's future while this invocation continues:
    // the following call already observes the cancellation.
    case "abort": {
      const rust = platform!.env.RUST;
      const before = await (await rust.fetch(API + "/stats")).json();
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);
      const aborted = await outcome(() => rust.fetch(API + "/slow", { signal: controller.signal }));
      const after = await (await rust.fetch(API + "/stats")).json();
      return json({ ...aborted, cancelledDuringInvocation: after.cancelled - before.cancelled });
    }
    // A same-origin `event.fetch` is answered by SvelteKit inside JavaScript.
    case "internal":
      return json(await outcome(() => fetch("/api/context")));
    default:
      error(404);
  }
};
