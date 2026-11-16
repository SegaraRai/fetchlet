param([ValidateSet('perry','scriptc')][string]$Tool)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$cache = Join-Path $root '.cache\tools'
New-Item -ItemType Directory -Path $cache -Force | Out-Null
if ($Tool -eq 'perry') {
  $url = 'https://github.com/PerryTS/perry/releases/download/v0.5.1665/perry-windows-x86_64.zip'
  $sha = '0677ab51c2851ccfb47afcb2b41b0dcdd24e5af0387b44748820931829481298'
  $archive = Join-Path $cache 'perry-0.5.1665.zip'
} else {
  $url = 'https://github.com/vercel-labs/scriptc/releases/download/v0.4.14/scriptc-0.4.14-win32-x64-msvc.tar.gz'
  $sha = '5ab7c1ed3156210ed22c57e8f44e7295d577e529290176f820919d5a7cd23b6d'
  $archive = Join-Path $cache 'scriptc-0.4.14.tar.gz'
}
if (-not (Test-Path -LiteralPath $archive)) { Invoke-WebRequest -Uri $url -OutFile $archive }
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha) { throw 'Release checksum mismatch' }
$destination = Join-Path $cache $Tool
New-Item -ItemType Directory -Path $destination -Force | Out-Null
if ($Tool -eq 'perry') {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($archive)
  try {
    foreach ($entry in $zip.Entries) {
      $resolved = [IO.Path]::GetFullPath((Join-Path $destination $entry.FullName))
      if (-not $resolved.StartsWith($destination + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe archive path' }
    }
  } finally { $zip.Dispose() }
  [IO.Compression.ZipFile]::ExtractToDirectory($archive, $destination, $true)
} else {
  $entries = & tar -tf $archive
  if ($LASTEXITCODE -ne 0) { throw 'Cannot list archive' }
  foreach ($entry in $entries) {
    $resolved = [IO.Path]::GetFullPath((Join-Path $destination $entry))
    if (-not $resolved.StartsWith($destination + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe archive path' }
  }
  & tar -xf $archive -C $destination
  if ($LASTEXITCODE -ne 0) { throw 'Cannot extract archive' }
}
[pscustomobject]@{ tool=$Tool; url=$url; sha256=$sha; destination=$destination } | ConvertTo-Json
Get-ChildItem -LiteralPath $destination -Recurse -Filter '*.exe' | Select-Object -First 8 -ExpandProperty FullName
