<script setup lang="ts">
const count = ref(0);
const hydrated = ref(false);
onMounted(() => {
  hydrated.value = true;
});
</script>

<template>
  <button type="button" data-counter :data-hydrated="hydrated" @click="count += 1">
    クリック {{ count }}
  </button>
</template>
