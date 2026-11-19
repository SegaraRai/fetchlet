// A module of functions only: without a default export, the artifact has no
// Fetch handler, and Rust calls each named export with App::call.

import { getBindings } from "fetchlet/runtime";

interface Bindings {
  GREETING: string;
}

/** A greeting with the word the Rust host binds as `GREETING`. */
export function greet(name: string): string {
  return `${getBindings<Bindings>().GREETING}, ${name}`;
}

/** How often each word occurs in `text`, most frequent first. */
export function wordCounts(text: string): [word: string, count: number][] {
  const counts = new Map<string, number>();
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts].sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
}

/** The hexadecimal SHA-256 digest of `text`, from the Web Crypto API. */
export async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
