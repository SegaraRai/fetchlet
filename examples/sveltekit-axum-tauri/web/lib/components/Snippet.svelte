<script lang="ts">
  import type { SnippetPart } from "#lib/api/types.gen.ts";

  let { parts }: { parts: SnippetPart[] } = $props();
</script>

<span class="snippet"
  >{#each parts as part, index (index)}{#if part.matched}<mark>{part.text}</mark
      >{:else}{part.text}{/if}{/each}</span
>
