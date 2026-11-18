<script lang="ts">
  import { page } from "$app/state";

  import Editor from "./Editor.svelte";
</script>

<!-- A new editor for each note, so unsaved text never carries over. -->
{#key page.params.path}
  <Editor path={page.params.path!} />
{/key}
