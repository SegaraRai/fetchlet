<script lang="ts">
  import { page } from "$app/state";
  import LocalTime from "#lib/components/LocalTime.svelte";
  import { getRenderedNote } from "#lib/notes.remote.ts";
  import { noteHref } from "#lib/paths.ts";

  const note = $derived(await getRenderedNote(page.params.path!));
  const outline = $derived(
    note.headings.filter((heading) => heading.depth > 1 && heading.depth < 4),
  );
  const folders = $derived(note.path.split("/").slice(0, -1));
</script>

<svelte:head><title>{note.title} — mdw</title></svelte:head>

<div class="note-layout">
  <article class="note">
    <header class="note-header">
      <nav class="breadcrumbs" aria-label="場所">
        {#each folders as folder, index (index)}<span>{folder}</span>{/each}
      </nav>
      <div class="note-actions">
        <LocalTime millis={note.modified} />
        <a class="button" href={noteHref(note.path) + "/edit"}>編集</a>
      </div>
    </header>
    {#if note.tags.length > 0}
      <ul class="tags">
        {#each note.tags as tag (tag)}<li>#{tag}</li>{/each}
      </ul>
    {/if}
    <div class="markdown">
      <!-- Rendered on the server; raw HTML in the note is dropped. -->
      {@html note.html}
    </div>
  </article>
  {#if outline.length > 0}
    <nav class="outline" aria-label="目次">
      <h2>目次</h2>
      <ul>
        {#each outline as heading (heading.id)}
          <li style:--depth={heading.depth - 2}><a href="#{heading.id}">{heading.text}</a></li>
        {/each}
      </ul>
    </nav>
  {/if}
</div>
