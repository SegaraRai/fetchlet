<script setup lang="ts">
const route = useRoute();
const visitor = useCookie<string | null>("visitor");
const name = computed(() => String(route.query.name ?? visitor.value ?? "guest"));
const { data: greeting } = await useFetch("/api/greeting");
</script>

<template>
  <main>
    <h1>Hello, {{ name }}</h1>
    <p data-message>{{ greeting?.message }}</p>
    <p data-service>{{ greeting?.service }}</p>
    <Counter />
    <form method="post" action="/greet">
      <label>Name <input name="name" required /></label>
      <button type="submit">Greet</button>
    </form>
  </main>
</template>
