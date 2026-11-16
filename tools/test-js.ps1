param([ValidateSet('Runtime', 'Host')][string]$Suite = 'Runtime')

$ErrorActionPreference = 'Stop'
$previousCC = $env:CC
$previousCXX = $env:CXX

try {
  if ($IsWindows -and (Test-Path -LiteralPath 'C:\Program Files\LLVM\bin\clang-cl.exe')) {
    $env:CC = 'C:\Program Files\LLVM\bin\clang-cl.exe'
    $env:CXX = $env:CC
  }

  cargo build --locked -p fetchlet --bin fetchlet-lab --all-features
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }

  $runner = if ($Suite -eq 'Host') { 'tools/test-host-matrix.mjs' } else { 'tools/test-matrix.mjs' }
  node $runner
  exit $LASTEXITCODE
} finally {
  $env:CC = $previousCC
  $env:CXX = $previousCXX
}
