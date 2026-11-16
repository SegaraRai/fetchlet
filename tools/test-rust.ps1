$ErrorActionPreference = 'Stop'
# The local MSVC flags must be paired with a compatible C compiler.
$previousCC = $env:CC
$previousCXX = $env:CXX
try {
  if ($IsWindows -and (Test-Path -LiteralPath 'C:\Program Files\LLVM\bin\clang-cl.exe')) {
    $env:CC = 'C:\Program Files\LLVM\bin\clang-cl.exe'
    $env:CXX = $env:CC
  }
  cargo fmt --all --check
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  cargo fmt --manifest-path fuzz/Cargo.toml --check
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  # Keep the host API usable independently from JavaScript engine features.
  cargo test --locked -p fetchlet --no-default-features
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  cargo clippy --locked -p fetchlet --all-targets --no-default-features -- -D warnings
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  cargo test --locked -p fetchlet --no-default-features --features quickjs,boa,v8
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  cargo clippy --locked -p fetchlet --all-targets --no-default-features --features quickjs,boa,v8 -- -D warnings
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  cargo test --locked -p fetchlet-axum --all-features
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  cargo clippy --locked -p fetchlet-axum --all-targets --all-features -- -D warnings
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  cargo check --locked -p fetchlet-axum --no-default-features
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  cargo clippy --locked -p example-sveltekit-axum -p example-astro-axum --all-targets -- -D warnings
  exit $LASTEXITCODE
} finally {
  $env:CC = $previousCC
  $env:CXX = $previousCXX
}
