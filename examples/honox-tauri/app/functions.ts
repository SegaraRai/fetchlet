// Named exports here are callable from Rust with `AppHandle::call`, beside
// the Fetch handler. The Tauri `greet` command calls `greet`.

export interface Greeting {
  greeting: string;
  characters: number;
}

export function greet(input: { name: string }): Greeting {
  const name = input.name.trim() || "ゲスト";
  return {
    greeting: `${name}さん、JavaScriptの関数からこんにちは。`,
    characters: [...name].length,
  };
}
