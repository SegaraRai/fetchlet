$ErrorActionPreference = 'Stop'
pwsh -NoProfile -File (Join-Path $PSScriptRoot 'cargo.ps1') build --locked --package fetchlet --bin fetchlet-lab --all-features
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node --test tools/test-polyfills.mjs
exit $LASTEXITCODE
