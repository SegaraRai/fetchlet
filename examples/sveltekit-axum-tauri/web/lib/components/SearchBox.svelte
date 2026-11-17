<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { searchNotes } from "#lib/notes.remote.ts";
  import { noteHref } from "#lib/paths.ts";
  import Snippet from "./Snippet.svelte";

  let query = $state(page.url.pathname === "/search" ? (page.url.searchParams.get("q") ?? "") : "");
  let settled = $state("");
  let open = $state(false);
  let active = $state(-1);

  // Ask the server once typing pauses.
  $effect(() => {
    const value = query.trim();
    const timer = setTimeout(() => (settled = value), 150);
    return () => clearTimeout(timer);
  });

  const hits = $derived(settled ? await searchNotes({ q: settled, limit: 8 }) : []);

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "ArrowDown") {
      active = Math.min(active + 1, hits.length - 1);
      event.preventDefault();
    } else if (event.key === "ArrowUp") {
      active = Math.max(active - 1, -1);
      event.preventDefault();
    } else if (event.key === "Enter" && active >= 0 && hits[active]) {
      event.preventDefault();
      open = false;
      void goto(noteHref(hits[active].path));
    } else if (event.key === "Escape") {
      open = false;
    }
  }
</script>

<!-- Without JavaScript the form opens the search page. -->
<form class="search" method="GET" action="/search" role="search">
  <input
    type="search"
    name="q"
    placeholder="Search…"
    autocomplete="off"
    aria-label="Search notes"
    bind:value={query}
    onfocus={() => (open = true)}
    oninput={() => {
      open = true;
      active = -1;
    }}
    onblur={() => setTimeout(() => (open = false), 150)}
    {onkeydown}
  />
  {#if open && settled && query.trim()}
    <ul class="suggestions" role="listbox">
      {#each hits as hit, index (hit.path)}
        <li role="option" aria-selected={index === active}>
          <a href={noteHref(hit.path)} onclick={() => (open = false)}>
            <strong>{hit.title}</strong>
            <Snippet parts={hit.snippet} />
          </a>
        </li>
      {:else}
        <li class="muted">No matches</li>
      {/each}
    </ul>
  {/if}
</form>
