<script lang="ts">
  import LocalTime from "#lib/components/LocalTime.svelte";
  import { getNotes, getWorkspace } from "#lib/notes.remote.ts";
  import { noteHref } from "#lib/paths.ts";

  const workspace = $derived(await getWorkspace());
  const recent = $derived(
    (await getNotes()).toSorted((a, b) => b.modified - a.modified).slice(0, 12),
  );
  const count = $derived(`${workspace.notes} ${workspace.notes === 1 ? "note" : "notes"}`);
</script>

<svelte:head><title>{workspace.name} — mdw</title></svelte:head>

<section class="overview">
  <h1>{workspace.name}</h1>
  <p class="muted">
    {count}{#if workspace.skipped > 0}
      ({workspace.skipped} left out for size or non-UTF-8 content){/if}
  </p>

  <h2>Recently updated</h2>
  <ul class="cards">
    {#each recent as note (note.path)}
      <li>
        <a href={noteHref(note.path)}>
          <strong>{note.title}</strong>
          <span class="muted">{note.path}</span>
          <LocalTime millis={note.modified} />
        </a>
      </li>
    {:else}
      <li class="muted">No notes yet. <a href="/new">Create the first note</a></li>
    {/each}
  </ul>
</section>
