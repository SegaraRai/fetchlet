<script lang="ts">
  import { page } from "$app/state";
  import Snippet from "#lib/components/Snippet.svelte";
  import { searchNotes } from "#lib/notes.remote.ts";
  import { noteHref } from "#lib/paths.ts";

  const query = $derived(page.url.searchParams.get("q") ?? "");
  const hits = $derived(await searchNotes({ q: query }));
</script>

<svelte:head><title>「{query}」の検索結果 — mdw</title></svelte:head>

<section class="narrow">
  <h1>「{query}」の検索結果</h1>
  <p class="muted">{hits.length} 件</p>
  <ol class="results">
    {#each hits as hit (hit.path)}
      <li>
        <a href={noteHref(hit.path)}><strong>{hit.title}</strong></a>
        <span class="muted">{hit.path}</span>
        <p><Snippet parts={hit.snippet} /></p>
      </li>
    {/each}
  </ol>
</section>
