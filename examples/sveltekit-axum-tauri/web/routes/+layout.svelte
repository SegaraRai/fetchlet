<script lang="ts">
  import "../app.css";
  import { onNavigate, refreshAll } from "$app/navigation";
  import { page } from "$app/state";
  import NoteTree from "#lib/components/NoteTree.svelte";
  import SearchBox from "#lib/components/SearchBox.svelte";
  import { subscribeToChanges } from "#lib/live.ts";
  import { getNotes, getWorkspace } from "#lib/notes.remote.ts";

  let { children } = $props();

  // Files edited elsewhere, by another editor or `git pull`, appear without a reload.
  $effect(() => subscribeToChanges(() => void refreshAll()));

  // Cross-fade between pages where the browser supports view transitions.
  onNavigate((navigation) => {
    if (!document.startViewTransition) return;
    return new Promise((resolve) => {
      document.startViewTransition(async () => {
        resolve();
        await navigation.complete;
      });
    });
  });
</script>

<div class="app">
  <aside class="sidebar">
    <header>
      <a class="brand" href="/">{(await getWorkspace()).name}</a>
      <a class="button" href="/new">New</a>
    </header>
    <SearchBox />
    <NoteTree notes={await getNotes()} current={page.params.path} />
  </aside>
  <main>
    {@render children()}
  </main>
</div>
