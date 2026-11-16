$ErrorActionPreference = 'Stop'
foreach ($name in @('sveltekit-axum', 'astro-axum')) {
  pwsh -NoProfile -File (Join-Path $PSScriptRoot 'test-example.ps1') -Name $name
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
