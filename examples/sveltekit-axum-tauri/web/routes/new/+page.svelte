<script lang="ts">
  import { createNote } from "#lib/notes.remote.ts";
</script>

<svelte:head><title>New note — mdw</title></svelte:head>

<section class="narrow">
  <h1>New note</h1>
  <form {...createNote} class="stack">
    <label>
      Name (separate folders with <code>/</code>)
      <input {...createNote.fields.path.as("text")} placeholder="journal/2026-11-17" />
    </label>
    {#each createNote.fields.path.issues() ?? [] as issue (issue.message)}
      <p class="error">{issue.message}</p>
    {/each}
    <button type="submit" class="primary" disabled={!!createNote.pending}>Create and edit</button>
  </form>
</section>
