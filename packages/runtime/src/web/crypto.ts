import { runtime } from "./runtime";

if (!runtime.crypto && typeof runtime.__fetchletHost === "function") {
  const host = (op: string, input: any) => {
    const result = JSON.parse(runtime.__fetchletHost(op, JSON.stringify(input)));
    if (!result.ok) {
      throw new Error(result.error);
    }
    return result.value;
  };
  runtime.crypto = {
    getRandomValues(view: any) {
      if (
        !ArrayBuffer.isView(view) ||
        view instanceof DataView ||
        view instanceof Float32Array ||
        view instanceof Float64Array
      ) {
        throw new TypeError("Expected integer typed array");
      }
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength).set(
        host("random", view.byteLength),
      );
      return view;
    },
    randomUUID() {
      const bytes = this.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      const hex = Array.from(bytes, (x: number) => x.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
    subtle: {
      async digest(algorithm: any, input: any) {
        if (
          String(typeof algorithm === "string" ? algorithm : algorithm.name).toUpperCase() !==
          "SHA-256"
        ) {
          throw new Error("Only SHA-256 is implemented");
        }
        const bytes =
          input instanceof ArrayBuffer
            ? new Uint8Array(input)
            : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
        return new Uint8Array(host("sha256", Array.from(bytes))).buffer;
      },
    },
  };
}
