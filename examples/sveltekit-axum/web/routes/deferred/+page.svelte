<script lang="ts">
  let { data } = $props();
</script>

<svelte:head><title>Deferred data</title></svelte:head>

<main>
  <h1>Deferred data</h1>
  {#await data.slow}
    <p data-pending>Loading…</p>
  {:then value}
    <p data-resolved>{value}</p>
  {/await}
</main>
