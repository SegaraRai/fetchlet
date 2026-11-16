globalThis.fetchletExports = (() => {
  let counter = 0;

  return {
    increment: () => ++counter,
    add: (left, right) => left + right,
    never: () => new Promise(() => {}),
    // ES2024 ArrayBuffer transfer, which Web Streams byte sources rely on.
    transfer: () => {
      const errorName = (operation) => {
        try {
          operation();
          return null;
        } catch (error) {
          return error.constructor.name;
        }
      };
      const source = new Uint8Array([1, 2, 3]).buffer;
      const shorter = source.transfer(2);
      const longer = new Uint8Array([4]).buffer.transferToFixedLength(3);
      return {
        detached: [source.detached, shorter.detached],
        sourceLength: source.byteLength,
        shorter: Array.from(new Uint8Array(shorter)),
        longer: Array.from(new Uint8Array(longer)),
        again: errorName(() => source.transfer()),
        invalidThis: errorName(() => ArrayBuffer.prototype.transfer.call({})),
      };
    },
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
