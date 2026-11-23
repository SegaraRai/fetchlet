let sequence = 0;
const host = globalThis.__fetchletClaimHost();

// Acknowledge entry through the private bridge so cancellation tests can wait
// for actual execution instead of relying on a scheduling delay.
function acknowledgeStart() {
  const started = JSON.parse(
    host.call(
      "fetch.start",
      JSON.stringify({
        service: "SIGNAL",
        redirect: "follow",
        request: {
          url: "https://signal.test/started",
          method: "GET",
          headers: [],
          body: null,
        },
      }),
    ),
  );
  if (!started.ok) {
    throw new Error("Signal service was not installed");
  }
  host.call("host.poll", "null");
}

globalThis.fetchletExports = {
  echo: (value) => value,
  add: (left, right) => left + right,
  sequence: () => ++sequence,
  fail: () => {
    throw new Error("guest failure");
  },
  never: () => {
    acknowledgeStart();
    return new Promise(() => {});
  },
  handle: (request, context) => ({
    status: 201,
    headers: [
      ["set-cookie", "first=1"],
      ["set-cookie", "second=2"],
      ["x-context", context?.name ?? "none"],
    ],
    body: request.body ?? [],
  }),
};
