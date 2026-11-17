<script lang="ts">
  import { onMount } from "svelte";

  let { millis }: { millis: number } = $props();

  // The server renders a date without a time zone; the browser then shows
  // its own local time, so hydration starts from the same text.
  let mounted = $state(false);
  onMount(() => (mounted = true));
  const iso = $derived(new Date(millis).toISOString());
  const text = $derived(
    mounted
      ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
          millis,
        )
      : iso.slice(0, 10),
  );
</script>

<time datetime={iso}>{text}</time>
