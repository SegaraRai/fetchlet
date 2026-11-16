param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('sveltekit-axum', 'astro-axum')]
  [string]$Name
)

$ErrorActionPreference = 'Stop'
vp run --filter "@fetchlet/example-$Name" build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
pwsh -NoProfile -File (Join-Path $PSScriptRoot 'cargo.ps1') build --locked --package "example-$Name"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node --test "examples/$Name/tests/e2e.mjs"
exit $LASTEXITCODE
