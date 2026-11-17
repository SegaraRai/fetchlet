<script lang="ts">
  import { createNote } from "#lib/notes.remote.ts";
</script>

<svelte:head><title>新しいノート — mdw</title></svelte:head>

<section class="narrow">
  <h1>新しいノート</h1>
  <form {...createNote} class="stack">
    <label>
      名前（フォルダーは <code>/</code> で区切ります）
      <input {...createNote.fields.path.as("text")} placeholder="journal/2026-11-17" />
    </label>
    {#each createNote.fields.path.issues() ?? [] as issue (issue.message)}
      <p class="error">{issue.message}</p>
    {/each}
    <button type="submit" class="primary" disabled={!!createNote.pending}>作成して編集</button>
  </form>
</section>
