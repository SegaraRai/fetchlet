<template>
  <div class="page">
    <nav>
      <NuxtLink to="/">ホーム</NuxtLink>
      <NuxtLink to="/about">このページについて</NuxtLink>
    </nav>
    <NuxtPage />
  </div>
</template>

<style>
body {
  font-family: system-ui, sans-serif;
  margin: 2rem;
}
nav {
  display: flex;
  gap: 1rem;
}
</style>
