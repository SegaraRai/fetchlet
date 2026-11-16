$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Push-Location -LiteralPath $root
try {
  New-Item -ItemType Directory -Path 'artifacts\aot','results\logs' -Force | Out-Null
  $env:PERRY_NO_AUTO_FETCH = '1'
  $env:PERRY_RUNTIME_DIR = Join-Path $root '.cache\tools\perry'
  $env:PERRY_STDLIB_DIR = $env:PERRY_RUNTIME_DIR
  $env:ZIG_GLOBAL_CACHE_DIR = Join-Path $root '.cache\zig-global'
  $zig = Join-Path $root '.cache\tools\zig-x86_64-windows-0.15.2\zig.exe'
  $env:PATH = (Split-Path -Parent $zig) + ';' + $env:PATH
  $rows = [Collections.Generic.List[object]]::new()
  function Record([string]$backend,[string]$stage,[int]$code,[string]$log) {
    $rows.Add([pscustomobject][ordered]@{backend=$backend;stage=$stage;status=$(if($code -eq 0){'pass'}else{'fail'});exitCode=$code;log=$log;diagnostics=((Get-Content -LiteralPath $log -Tail 18) -join "`n")})
  }
  & '.cache\tools\perry\perry.exe' compile fixtures\aot\native.ts --output-type staticlib -o artifacts\aot\perry-native.lib *> results\logs\perry-static-build.log
  $built = $LASTEXITCODE
  Record perry static-library $built 'results/logs/perry-static-build.log'
  if ($built -eq 0) {
    # Symbols/signatures are specific to this fixture, verified using Perry LLVM output.
    rustc --edition=2024 --cfg perry tools\aot-native-host.rs -L artifacts\aot -L .cache\tools\perry -l static=perry-native -l static=perry_runtime -l static=perry_stdlib -o artifacts\aot\rust-perry-host.exe *> results\logs\perry-rust-msvc.log
    $linked = $LASTEXITCODE
    Record perry rust-msvc-link $linked 'results/logs/perry-rust-msvc.log'
    if ($linked -eq 0) {
      & '.\artifacts\aot\rust-perry-host.exe' *> results\logs\perry-rust-run.log
      Record perry rust-msvc-execution $LASTEXITCODE 'results/logs/perry-rust-run.log'
    }
  }
  & '.cache\tools\scriptc\bin\scriptc.exe' build --lib --profile fixtures\aot\native.profile.json -o artifacts\aot\scriptc-native.lib.a *> results\logs\scriptc-static-build.log
  $built = $LASTEXITCODE
  Record scriptc static-library $built 'results/logs/scriptc-static-build.log'
  if ($built -eq 0) {
    Copy-Item -LiteralPath 'artifacts\aot\scriptc-native.lib.a' -Destination 'artifacts\aot\scriptc-native.lib' -Force
    rustc --edition=2024 --cfg scriptc tools\aot-native-host.rs -L artifacts\aot -l static=scriptc-native -o artifacts\aot\rust-scriptc-host.exe *> results\logs\scriptc-rust-msvc.log
    $linked = $LASTEXITCODE
    Record scriptc rust-msvc-link $linked 'results/logs/scriptc-rust-msvc.log'
    if ($linked -eq 0) {
      & '.\artifacts\aot\rust-scriptc-host.exe' *> results\logs\scriptc-rust-run.log
      Record scriptc rust-msvc-execution $LASTEXITCODE 'results/logs/scriptc-rust-run.log'
    }
    # scriptc reports an MSVC target but its native driver uses the GNU CRT.
    # This extra probe keeps Rust in charge of the TS calls, with a C entry point.
    rustc --edition=2024 --crate-type lib --emit=obj -C panic=abort tools\aot-rust-probe.rs -o artifacts\aot\rust-scriptc-probe.obj *> results\logs\scriptc-rust-object.log
    $compiled = $LASTEXITCODE
    Record scriptc rust-object $compiled 'results/logs/scriptc-rust-object.log'
    if ($compiled -eq 0) {
      & $zig cc -target x86_64-windows-gnu tools\aot-c-bootstrap.c artifacts\aot\rust-scriptc-probe.obj artifacts\aot\scriptc-native.lib.a '-Wl,--gc-sections' -ladvapi32 -liphlpapi -lws2_32 -o artifacts\aot\rust-scriptc-gnu-host.exe *> results\logs\scriptc-gnu-link.log
      $linked = $LASTEXITCODE
      Record scriptc rust-with-c-gnu-bootstrap-link $linked 'results/logs/scriptc-gnu-link.log'
      if ($linked -eq 0) {
        & '.\artifacts\aot\rust-scriptc-gnu-host.exe' *> results\logs\scriptc-gnu-run.log
        Record scriptc rust-with-c-gnu-bootstrap-execution $LASTEXITCODE 'results/logs/scriptc-gnu-run.log'
      }
    }
  }
  [ordered]@{checkedAt=[DateTime]::UtcNow.ToString('o');target='x86_64-pc-windows-msvc';perry='0.5.1665';scriptc='0.4.14';zig='0.15.2';results=$rows.ToArray()} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath results\native-link-matrix.json -Encoding utf8
  $rows | Select-Object backend,stage,status | Format-Table
  if ($rows.Where({$_.status -eq 'fail'}).Count) { exit 1 }
} finally { Pop-Location }
