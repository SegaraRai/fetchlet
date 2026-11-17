<script lang="ts">
  let { data, form } = $props();
</script>

<svelte:head>
  <title>Projects</title>
</svelte:head>

<main>
  <h1>Projects</h1>
  <ul>
    {#each data.projects as project (project.id)}
      <li>{project.id}: {project.name}</li>
    {/each}
  </ul>
  {#if form?.error}
    <p role="alert">{form.error}</p>
  {/if}
  <form method="POST">
    <label for="name">Name</label>
    <input id="name" name="name" />
    <button type="submit">Add</button>
  </form>
  <a href="/">Back to the top</a>
</main>
