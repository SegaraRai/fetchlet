export default function About() {
  return (
    <main>
      <h1>About</h1>
      <p>fetchlet runs Waku's React Server Components and SSR inside axum.</p>
    </main>
  );
}

export const getConfig = async () => ({ render: "dynamic" }) as const;
