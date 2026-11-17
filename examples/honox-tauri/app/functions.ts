// Named exports here are callable from Rust with `AppHandle::call`, beside
// the Fetch handler. The Tauri `greet` command calls `greet`.

export interface Greeting {
  greeting: string;
  characters: number;
}

export function greet(input: { name: string }): Greeting {
  const name = input.name.trim() || "guest";
  return {
    greeting: `Hello from a JavaScript function, ${name}.`,
    characters: [...name].length,
  };
}
