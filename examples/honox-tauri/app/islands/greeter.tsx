import { invoke } from "@tauri-apps/api/core";
import { useState } from "hono/jsx";

interface Greeting {
  greeting: string;
  characters: number;
}

// Calls the Tauri `greet` command, which calls the `greet` export through fetchlet.
export default function Greeter() {
  const [name, setName] = useState("Tauri");
  const [result, setResult] = useState("");
  return (
    <form
      data-greeter
      onSubmit={async (event: Event) => {
        event.preventDefault();
        try {
          const greeting = await invoke<Greeting>("greet", { name });
          setResult(`${greeting.greeting} (${greeting.characters} characters)`);
        } catch (error) {
          setResult(`Failed: ${String(error)}`);
        }
      }}
    >
      <input
        name="name"
        value={name}
        onInput={(event: Event) => setName((event.target as HTMLInputElement).value)}
      />
      <button type="submit">Greet with a command</button>
      <output data-greeting>{result}</output>
    </form>
  );
}
