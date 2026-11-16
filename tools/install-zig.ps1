$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$cache=Join-Path $root '.cache\tools'
$archive=Join-Path $cache 'zig-0.15.2.zip'
$url='https://ziglang.org/download/0.15.2/zig-x86_64-windows-0.15.2.zip'
$sha='3a0ed1e8799a2f8ce2a6e6290a9ff22e6906f8227865911fb7ddedc3cc14cb0c'
if(-not(Test-Path -LiteralPath $archive)){Invoke-WebRequest -Uri $url -OutFile $archive}
if((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha){throw 'Zig checksum mismatch'}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead($archive)
try{foreach($entry in $zip.Entries){$resolved=[IO.Path]::GetFullPath((Join-Path $cache $entry.FullName));if(-not $resolved.StartsWith($cache+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Unsafe archive path'}}}finally{$zip.Dispose()}
[IO.Compression.ZipFile]::ExtractToDirectory($archive,$cache,$true)
& (Join-Path $cache 'zig-x86_64-windows-0.15.2\zig.exe') version
