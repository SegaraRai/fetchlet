<script lang="ts">
  import { page } from "$app/state";
  import Snippet from "#lib/components/Snippet.svelte";
  import { searchNotes } from "#lib/notes.remote.ts";
  import { noteHref } from "#lib/paths.ts";

  const query = $derived(page.url.searchParams.get("q") ?? "");
  const hits = $derived(await searchNotes({ q: query }));
</script>

<svelte:head><title>Results for “{query}” — mdw</title></svelte:head>

<section class="narrow">
  <h1>Results for “{query}”</h1>
  <p class="muted">{hits.length} {hits.length === 1 ? "result" : "results"}</p>
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
