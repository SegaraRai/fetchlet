<script lang="ts">
  import { beforeNavigate } from "$app/navigation";

  import { subscribeToChanges } from "#lib/live.ts";
  import {
    deleteNote,
    getNote,
    getRenderedNote,
    renderPreview,
    saveNote,
  } from "#lib/notes.remote.ts";
  import { noteHref } from "#lib/paths.ts";

  let { path }: { path: string } = $props();

  // The note as loaded. The page creates a new editor for each path, and the
  // editor keeps its own text and base version, so a refresh of the query
  // does not overwrite what is being typed.
  // svelte-ignore state_referenced_locally
  const loaded = await getNote(path);
  // svelte-ignore state_referenced_locally
  const initialPreview = (await getRenderedNote(path)).html;
  const saved = loaded.content;
  const baseVersion = loaded.version;
  let preview = $state(initialPreview);
  let changedOnDisk = $state(false);
  let leaving = false;

  // The field holds the loaded text until it is edited.
  const content = $derived(saveNote.fields.content.value() ?? saved);
  const dirty = $derived(content !== saved);
  const conflict = $derived(saveNote.result?.conflict);

  // Render the preview in the Rust process once typing pauses.
  $effect(() => {
    const text = content;
    if (text === saved && preview === initialPreview) {return;}
    const timer = setTimeout(async () => {
      preview = await renderPreview({ path, content: text });
    }, 250);
    return () => clearTimeout(timer);
  });

  $effect(() =>
    subscribeToChanges((change) => {
      if (change.paths.includes(path)) {changedOnDisk = true;}
    }),
  );

  beforeNavigate((navigation) => {
    // A saved note redirects to its page. That navigation can start after
    // submit() has resolved, so it is recognized by where it goes.
    const saved =
      navigation.type === "goto" &&
      navigation.to?.url.pathname === new URL(noteHref(path), location.href).pathname;
    if (dirty && !leaving && !saved && !confirm("Discard unsaved changes?")) {navigation.cancel();}
  });

  function onkeydown(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key === "s") {
      event.preventDefault();
      saveNote.element?.requestSubmit();
    }
  }
</script>

<svelte:head><title>Edit {path} — mdw</title></svelte:head>
<svelte:window {onkeydown} />

<div class="editor">
  <form
    class="editor-form"
    {...saveNote.enhance(async ({ submit }) => {
      leaving = true;
      try {
        await submit();
      } finally {
        leaving = false;
      }
    })}
  >
    <header class="editor-toolbar">
      <a href={noteHref(path)} class="path">{path}</a>
      <span class="status" aria-live="polite">
        {#if saveNote.pending}Saving…{:else if dirty}Unsaved changes{:else}Saved{/if}
      </span>
      <button type="submit" class="primary" disabled={!!saveNote.pending}
        >Save <kbd>Ctrl+S</kbd></button
      >
    </header>

    {#if conflict !== undefined}
      <div class="banner warning" role="alert">
        <p>This note was {conflict === null ? "deleted" : "changed"} after it was loaded.</p>
        <button {...saveNote.fields.overwrite.as("submit", conflict ?? "")}
          >Overwrite with this version</button
        >
        <a href={noteHref(path) + "/edit"} data-sveltekit-reload>Discard and reload</a>
      </div>
    {:else if changedOnDisk}
      <div class="banner" role="status">
        <p>This note changed outside the editor. Saving checks for a conflict.</p>
      </div>
    {/if}
    {#each saveNote.fields.allIssues() ?? [] as issue (issue.message)}
      <p class="banner warning">{issue.message}</p>
    {/each}

    <input {...saveNote.fields.path.as("hidden", path)} />
    <input {...saveNote.fields.base_version.as("hidden", baseVersion)} />
    <div class="panes">
      <textarea
        {...saveNote.fields.content.as("text", saved)}
        spellcheck="false"
        aria-label="Markdown"></textarea>
      <div class="preview markdown" aria-label="Preview">{@html preview}</div>
    </div>
  </form>

  <form
    class="danger-zone"
    {...deleteNote.enhance(async ({ submit }) => {
      if (!confirm(`Delete ${path}?`)) return;
      leaving = true;
      await submit();
    })}
  >
    <input {...deleteNote.fields.path.as("hidden", path)} />
    <input {...deleteNote.fields.version.as("hidden", baseVersion)} />
    <button type="submit" class="danger">Delete</button>
  </form>
</div>
