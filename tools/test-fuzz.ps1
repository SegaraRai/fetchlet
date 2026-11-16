param(
  [ValidateRange(1, 100000000)][int]$Runs = 1000000,
  [ValidateRange(1, 3600)][int]$Seconds = 30
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$previousPath = $env:PATH
$previousCC = $env:CC
$previousCXX = $env:CXX

Push-Location -LiteralPath $root
try {
  $localTools = Join-Path $root '.cache\tools\cargo-fuzz\bin'
  if (Test-Path -LiteralPath $localTools) {
    $env:PATH = $localTools + [IO.Path]::PathSeparator + $env:PATH
  }

  if ($IsWindows) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $installation) {
      throw 'MSVC tools and C++ AddressSanitizer are required for Windows fuzzing.'
    }

    $toolchains = Join-Path $installation 'VC\Tools\MSVC'
    $toolchain = Get-ChildItem -LiteralPath $toolchains -Directory |
      Sort-Object Name -Descending |
      Select-Object -First 1
    $compilerBin = Join-Path $toolchain.FullName 'bin\Hostx64\x64'
    $asanRuntime = Join-Path $compilerBin 'clang_rt.asan_dynamic-x86_64.dll'
    if (-not (Test-Path -LiteralPath $asanRuntime)) {
      throw 'Install the Visual Studio C++ AddressSanitizer component to run fuzzing.'
    }

    $env:PATH = $compilerBin + [IO.Path]::PathSeparator + $env:PATH
    if (Test-Path -LiteralPath 'C:\Program Files\LLVM\bin\clang-cl.exe') {
      $env:CC = 'C:\Program Files\LLVM\bin\clang-cl.exe'
      $env:CXX = $env:CC
    }
  }

  New-Item -ItemType Directory -Path '.cache', 'results' -Force | Out-Null
  # fetch_service: the Rust host fetch boundary. bridge_bodies: byte handles
  # and body sources as a guest drives them through the native protocol.
  $targets = @('fetch_service', 'bridge_bodies')
  $results = foreach ($target in $targets) {
    $log = Join-Path $root ".cache\fuzz-$target.log"
    cargo +nightly fuzz run $target -- "-runs=$Runs" "-max_total_time=$Seconds" -max_len=16384 *> $log
    $fuzzExit = $LASTEXITCODE
    $output = Get-Content -LiteralPath $log -Raw
    $completed = [regex]::Match($output, 'Done (\d+) runs')
    Write-Host "== $target"
    Get-Content -LiteralPath $log -Tail 8 | Write-Host
    [ordered]@{
      target = $target
      status = if ($fuzzExit -eq 0 -and $completed.Success) { 'pass' } else { 'fail' }
      completedRuns = if ($completed.Success) { [long]$completed.Groups[1].Value } else { 0 }
    }
  }

  [ordered]@{
    checkedAt = [DateTime]::UtcNow.ToString('o')
    sanitizer = 'address'
    requestedRuns = $Runs
    timeBudgetSeconds = $Seconds
    compiler = (& rustc +nightly --version)
    maxInputBytes = 16384
    targets = @($results)
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath 'results\fuzz-smoke.json' -Encoding utf8

  if (@($results | Where-Object { $_.status -ne 'pass' }).Count -gt 0) {
    exit 1
  }
} finally {
  $env:PATH = $previousPath
  $env:CC = $previousCC
  $env:CXX = $previousCXX
  Pop-Location
}
