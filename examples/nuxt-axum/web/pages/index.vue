<script setup lang="ts">
const route = useRoute();
const visitor = useCookie<string | null>("visitor");
const name = computed(() => String(route.query.name ?? visitor.value ?? "ゲスト"));
const { data: greeting } = await useFetch("/api/greeting");
</script>

<template>
  <main>
    <h1>こんにちは、{{ name }}</h1>
    <p data-message>{{ greeting?.message }}</p>
    <p data-service>{{ greeting?.service }}</p>
    <Counter />
    <form method="post" action="/greet">
      <label>名前 <input name="name" required /></label>
      <button type="submit">挨拶する</button>
    </form>
  </main>
</template>
