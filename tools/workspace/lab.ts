// The line protocol of fetchlet-lab and the Node reference host: each stdin
// line is `{ "export": name, "args": [...] }`, and each reply is one stdout
// line `FETCHLET_REPLY {"ok":true,"value":...}` or `{"ok":false,"error":...}`.

import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { labBinary, root } from "./paths.ts";

export const replyPrefix = "FETCHLET_REPLY ";

/** A JavaScript engine of fetchlet-lab, or Node with its native Web APIs. */
export type Backend = "quickjs" | "boa" | "v8";
export type HostBackend = Backend | "node-reference";

export const backends: readonly Backend[] = ["quickjs", "boa", "v8"];
export const hostBackends: readonly HostBackend[] = ["node-reference", ...backends];

export type Reply = { ok: true; value: any } | { ok: false; error: string };

export interface Invocation {
  export: string;
  args?: unknown[];
}

/** The command that evaluates `bundle` on a backend and answers invocations. */
export function hostCommand(backend: HostBackend, bundle: string, extra: string[] = []) {
  return backend === "node-reference"
    ? { command: process.execPath, args: [resolve(root, "tools/workspace/node-host.ts"), bundle] }
    : { command: labBinary, args: [backend, bundle, ...extra] };
}

export function parseReplies(stdout: string): Reply[] {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(replyPrefix))
    .map((line) => JSON.parse(line.slice(replyPrefix.length)) as Reply);
}

export interface HostSession {
  /** Sends one invocation and resolves with its reply. */
  raw(name: string, args?: unknown[]): Promise<Reply>;
  /** Sends one invocation and resolves with its value, or rejects with its error. */
  call(name: string, args?: unknown[]): Promise<any>;
  /** Ends the session and returns the host's stderr. */
  close(): string;
}

/** Starts a host process that keeps one instance across invocations. */
export function startHost(backend: HostBackend, bundle: string, timeoutMs = 15_000): HostSession {
  const { command, args } = hostCommand(backend, bundle);
  const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: "pipe" });
  type Pending = { resolve(reply: Reply): void; reject(error: Error): void };
  let pending: Pending | null = null;
  let stderr = "";
  let ended = false;
  child.stderr.on("data", (chunk) => (stderr += chunk));
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.startsWith(replyPrefix)) {
      stderr += "[stdout] " + line + "\n";
      return;
    }
    const current = pending;
    pending = null;
    try {
      current?.resolve(JSON.parse(line.slice(replyPrefix.length)) as Reply);
    } catch (error) {
      current?.reject(error as Error);
    }
  });
  child.on("error", (error) => {
    ended = true;
    pending?.reject(error);
    pending = null;
  });
  child.on("exit", (code, signal) => {
    ended = true;
    pending?.reject(new Error(`Host exited ${code}/${signal}: ${stderr.slice(-3000)}`));
    pending = null;
  });
  return {
    raw(name, invocationArgs = []) {
      if (ended)
        return Promise.reject(new Error("Host is no longer running: " + stderr.slice(-1000)));
      return new Promise<Reply>((resolveReply, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("Host deadline exceeded"));
        }, timeoutMs);
        pending = {
          resolve(reply) {
            clearTimeout(timer);
            resolveReply(reply);
          },
          reject(error) {
            clearTimeout(timer);
            reject(error);
          },
        };
        child.stdin.write(JSON.stringify({ export: name, args: invocationArgs }) + "\n");
      });
    },
    async call(name, invocationArgs = []) {
      const reply = await this.raw(name, invocationArgs);
      if (!reply.ok) throw new Error(reply.error);
      return reply.value;
    },
    close() {
      child.stdin.end();
      if (!ended) child.kill();
      return stderr;
    },
  };
}

export interface SessionResult {
  status: number | null;
  stdout: string;
  stderr: string;
  replies: Reply[];
}

/** Runs fetchlet-lab once with the given stdin lines and waits for it to exit. */
export function runLab(
  args: string[],
  lines: unknown[],
  { timeoutMs = 15_000 }: { timeoutMs?: number } = {},
): SessionResult {
  const execution = spawnSync(labBinary, args, {
    cwd: root,
    input: lines.map((line) => JSON.stringify(line) + "\n").join(""),
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (execution.error) throw execution.error;
  return {
    status: execution.status,
    stdout: execution.stdout,
    stderr: execution.stderr,
    replies: parseReplies(execution.stdout),
  };
}
