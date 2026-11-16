<script lang="ts">
  let { data, form } = $props();
</script>

<svelte:head>
  <title>プロジェクト</title>
</svelte:head>

<main>
  <h1>プロジェクト</h1>
  <ul>
    {#each data.projects as project (project.id)}
      <li>{project.id}: {project.name}</li>
    {/each}
  </ul>
  {#if form?.error}
    <p role="alert">{form.error}</p>
  {/if}
  <form method="POST">
    <label for="name">名前</label>
    <input id="name" name="name" />
    <button type="submit">追加する</button>
  </form>
  <a href="/">トップへ</a>
</main>
