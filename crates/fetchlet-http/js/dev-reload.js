// The browser script fetchlet-http's DevService links from HTML pages during
// development. It long-polls for a new generation of the server and reloads
// the page when the token differs from the one the page was served with.
// Failed polls, such as while the server restarts, are retried after a
// second.

const token = new URL(import.meta.url).searchParams.get("token") ?? "";

for (;;) {
  try {
    const response = await fetch(`/__fetchlet/reload?token=${encodeURIComponent(token)}`, {
      cache: "no-store",
    });
    if (response.ok) {
      if ((await response.text()) !== token) {
        location.reload();
        break;
      }
      continue;
    }
  } catch {
    // Retried below.
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
