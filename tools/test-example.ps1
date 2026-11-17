param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('sveltekit-axum', 'astro-axum', 'nuxt-axum', 'react-router-axum', 'honox-axum', 'tanstack-start-axum', 'solidstart-axum', 'qwik-city-axum', 'waku-axum', 'vinext-axum', 'honox-tauri', 'sveltekit-axum-tauri')]
  [string]$Name
)

$ErrorActionPreference = 'Stop'
vp run --filter "@fetchlet/example-$Name" build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
pwsh -NoProfile -File (Join-Path $PSScriptRoot 'cargo.ps1') build --locked --package "example-$Name"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
# Each example's suites: e2e.mjs, and desktop.mjs for an example with a window.
$suites = Get-ChildItem -Path "examples/$Name/tests" -Filter '*.mjs' | ForEach-Object { $_.FullName }
node --test @suites
exit $LASTEXITCODE
