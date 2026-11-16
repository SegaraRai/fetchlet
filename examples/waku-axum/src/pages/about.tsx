export default function About() {
  return (
    <main>
      <h1>このページについて</h1>
      <p>WakuのReact Server ComponentsとSSRを、axumの中のfetchletで実行しています。</p>
    </main>
  );
}

export const getConfig = async () => ({ render: "dynamic" }) as const;
