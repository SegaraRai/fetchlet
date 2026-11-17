// The pinned AOT compilers and the Zig linker, their release archives and
// where `install.ts` places them. Only the Windows x64 releases are pinned.
import { resolve } from "node:path";

import { root, toolCache } from "@fetchlet-internal/tools-workspace/paths";
import { prependPath } from "@fetchlet-internal/tools-workspace/process";

export interface Release {
  version: string;
  url: string;
  sha256: string;
  archive: string;
  /** The directory the archive extracts into. */
  destination: string;
}

export const releases = {
  perry: {
    version: "0.5.1665",
    url: "https://github.com/PerryTS/perry/releases/download/v0.5.1665/perry-windows-x86_64.zip",
    sha256: "0677ab51c2851ccfb47afcb2b41b0dcdd24e5af0387b44748820931829481298",
    archive: "perry-0.5.1665.zip",
    destination: "perry",
  },
  scriptc: {
    version: "0.4.14",
    url: "https://github.com/vercel-labs/scriptc/releases/download/v0.4.14/scriptc-0.4.14-win32-x64-msvc.tar.gz",
    sha256: "5ab7c1ed3156210ed22c57e8f44e7295d577e529290176f820919d5a7cd23b6d",
    archive: "scriptc-0.4.14.tar.gz",
    destination: "scriptc",
  },
  zig: {
    version: "0.15.2",
    url: "https://ziglang.org/download/0.15.2/zig-x86_64-windows-0.15.2.zip",
    sha256: "3a0ed1e8799a2f8ce2a6e6290a9ff22e6906f8227865911fb7ddedc3cc14cb0c",
    archive: "zig-0.15.2.zip",
    // The archive has its own top-level directory, zig-x86_64-windows-0.15.2.
    destination: ".",
  },
} satisfies Record<string, Release>;

export type Tool = keyof typeof releases;

export const perryDirectory = resolve(toolCache, "perry");
export const perry = resolve(perryDirectory, "perry.exe");
export const scriptc = resolve(toolCache, "scriptc/bin/scriptc.exe");
export const zigDirectory = resolve(toolCache, "zig-x86_64-windows-0.15.2");
export const zig = resolve(zigDirectory, "zig.exe");

/** The environment the compilers run in: offline Perry, and Zig on PATH for scriptc. */
export function compilerEnv(): NodeJS.ProcessEnv {
  return {
    ...prependPath([zigDirectory]),
    ZIG_GLOBAL_CACHE_DIR: resolve(root, ".cache/zig-global"),
    PERRY_NO_AUTO_FETCH: "1",
    PERRY_RUNTIME_DIR: perryDirectory,
    PERRY_STDLIB_DIR: perryDirectory,
  };
}
