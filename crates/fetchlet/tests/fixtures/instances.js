globalThis.fetchletExports = (() => {
  let counter = 0;

  return {
    increment: () => ++counter,
    add: (left, right) => left + right,
    never: () => new Promise(() => {}),
    handle: (request) => ({
      status: 201,
      headers: [
        ["set-cookie", "a=1"],
        ["set-cookie", "b=2"],
      ],
      body: request.body,
    }),
  };
})();
