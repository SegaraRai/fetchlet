$ErrorActionPreference = 'Stop'
foreach ($name in @(
    'sveltekit-axum', 'astro-axum', 'nuxt-axum', 'react-router-axum', 'honox-axum',
    'tanstack-start-axum', 'solidstart-axum', 'qwik-city-axum', 'waku-axum', 'vinext-axum',
    'honox-tauri', 'sveltekit-axum-tauri'
  )) {
  pwsh -NoProfile -File (Join-Path $PSScriptRoot 'test-example.ps1') -Name $name
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
