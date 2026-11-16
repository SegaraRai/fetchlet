$ErrorActionPreference = 'Stop'
pwsh -NoProfile -File (Join-Path $PSScriptRoot 'cargo.ps1') build --locked --package fetchlet --bin fetchlet-lab --all-features
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node tools/conformance/cli.mjs @args
exit $LASTEXITCODE
