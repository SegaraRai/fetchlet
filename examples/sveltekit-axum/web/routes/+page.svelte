<script lang="ts">
  import { onMount } from "svelte";

  let { data, form } = $props();
  let clicks = $state(0);
  let hydrated = $state(false);
  onMount(() => {
    hydrated = true;
  });
</script>

<svelte:head>
  <title>fetchlet greeting</title>
</svelte:head>

<main data-hydrated={hydrated}>
  <h1>Hello, {form?.name ?? data.name}</h1>
  <p>{data.message}</p>
  <p>{data.greeting}</p>

  <form method="POST">
    <label for="name">Name</label>
    <input id="name" name="name" value={form?.name ?? data.name} />
    <button type="submit">Greet</button>
  </form>

  <button type="button" onclick={() => (clicks += 1)}>Clicks {clicks}</button>
  <a href="/about">About</a>
  <a href="/projects">Projects</a>
</main>

<style>
  :global(body) {
    margin: 0;
    color: #243047;
    background: #f4f6f8;
    font-family: system-ui, sans-serif;
  }
  main {
    max-width: 40rem;
    margin: 4rem auto;
    padding: 2rem;
    background: white;
    border-radius: 1rem;
  }
  form {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    margin: 2rem 0;
  }
  input,
  button {
    font: inherit;
    padding: 0.5rem 0.75rem;
  }
  a {
    display: block;
    margin-top: 2rem;
  }
</style>
