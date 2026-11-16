<script lang="ts">
  import { onMount } from "svelte";

  let clicks = $state(0);
  let hydrated = $state(false);
  onMount(() => {
    hydrated = true;
  });
</script>

<div data-counter data-hydrated={hydrated}>
  <button type="button" onclick={() => clicks += 1}>クリック {clicks}</button>
</div>
