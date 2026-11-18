<script>
  let { data } = $props();
</script>

<svelte:head><title>fetchlet SvelteKit</title></svelte:head>
<h1>Hello, {data.name}</h1>
<p data-fixture="sveltekit">SSR from Rust</p>
