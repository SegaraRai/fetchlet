# Forward Cargo arguments through PowerShell's ordinary script argument list.
$ErrorActionPreference = 'Stop'
$previousCC = $env:CC
$previousCXX = $env:CXX
try {
  if ($IsWindows -and (Test-Path -LiteralPath 'C:\Program Files\LLVM\bin\clang-cl.exe')) {
    $env:CC = 'C:\Program Files\LLVM\bin\clang-cl.exe'
    $env:CXX = $env:CC
  }
  cargo @args
  exit $LASTEXITCODE
} finally {
  $env:CC = $previousCC
  $env:CXX = $previousCXX
}
