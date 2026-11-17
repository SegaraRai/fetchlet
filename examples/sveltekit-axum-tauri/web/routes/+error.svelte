<script lang="ts">
  import { page } from "$app/state";
</script>

<section class="narrow">
  <h1>{page.status}</h1>
  <p>{page.error?.message}</p>
  <p><a href="/">ワークスペースに戻る</a></p>
</section>
