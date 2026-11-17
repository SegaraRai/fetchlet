import { resolve } from "node:path";

/** The repository root. Tools resolve every path from here, not from the working directory. */
export const root = resolve(import.meta.dirname, "../..");

/** The file name suffix of executables on this platform. */
export const exe = process.platform === "win32" ? ".exe" : "";

/** The debug build of the verification host, built by `vp run build:lab`. */
export const labBinary = resolve(root, `target/debug/fetchlet-lab${exe}`);

/** The debug build of an example's Rust server. */
export function exampleBinary(name: string, profile: "debug" | "release" = "debug"): string {
  return resolve(root, `target/${profile}/example-${name}${exe}`);
}

/** Tool downloads such as AOT compilers, kept out of the repository. */
export const toolCache = resolve(root, ".cache/tools");
