<script lang="ts">
  import LocalTime from "#lib/components/LocalTime.svelte";
  import { getNotes, getWorkspace } from "#lib/notes.remote.ts";
  import { noteHref } from "#lib/paths.ts";

  const workspace = $derived(await getWorkspace());
  const recent = $derived(
    (await getNotes()).toSorted((a, b) => b.modified - a.modified).slice(0, 12),
  );
</script>

<svelte:head><title>{workspace.name} — mdw</title></svelte:head>

<section class="overview">
  <h1>{workspace.name}</h1>
  <p class="muted">
    {workspace.notes} 件のノート{#if workspace.skipped > 0}（{workspace.skipped}
      件はサイズ超過または UTF-8 以外のため除外）{/if}
  </p>

  <h2>最近更新したノート</h2>
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
      <li class="muted">まだノートがありません。<a href="/new">最初のノートを作る</a></li>
    {/each}
  </ul>
</section>
