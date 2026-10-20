[CmdletBinding()]
param([string]$RuntimeDir = '')

$ErrorActionPreference = 'Stop'
if (-not $RuntimeDir) {
    $localAppData = $env:LOCALAPPDATA
    if (-not $localAppData -or -not [IO.Path]::IsPathRooted($localAppData)) {
        $localAppData = Join-Path $env:USERPROFILE 'AppData\Local'
    }
    $RuntimeDir = Join-Path $localAppData 'SmoothPdfReader\voice-runtime'
}
$archiveUrl = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip'
$archiveSha = 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c'
$modelUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin'
$modelSha = '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'
$modelSize = 147951465

if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw 'This installer supports Windows x64 only.' }
if (-not [IO.Path]::IsPathRooted($RuntimeDir)) { throw 'RuntimeDir must be an absolute directory.' }
$runtimeRoot = [IO.Path]::GetFullPath($RuntimeDir).TrimEnd([IO.Path]::DirectorySeparatorChar)
if ([IO.Path]::GetPathRoot($runtimeRoot).TrimEnd('\') -eq $runtimeRoot -or $runtimeRoot -eq [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\')) { throw 'Refusing a broad runtime directory.' }
if (Test-Path -LiteralPath $runtimeRoot) {
    $rootItem = Get-Item -LiteralPath $runtimeRoot -Force
    if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Runtime directory must be a normal local directory.' }
}
$manifestPath = Join-Path $runtimeRoot 'runtime.json'
if (Test-Path -LiteralPath $manifestPath) {
    $manifestItem = Get-Item -LiteralPath $manifestPath -Force
    if ($manifestItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing to replace a linked runtime manifest.' }
    $previous = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($previous.schemaVersion -ne 1 -or $previous.engine -ne 'whisper.cpp' -or $previous.archive.url -ne $archiveUrl -or $previous.archive.sha256 -ne $archiveSha) {
        throw 'An unknown runtime manifest exists. It has been left unchanged.'
    }
} elseif ((Test-Path -LiteralPath $runtimeRoot) -and @(Get-ChildItem -LiteralPath $runtimeRoot -Force).Count -gt 0) {
    throw 'The runtime directory contains unknown files. Choose a new empty directory; nothing was overwritten.'
}

$releaseId = 'b5130-' + [Guid]::NewGuid().ToString('N')
$releaseRoot = Join-Path (Join-Path $runtimeRoot 'releases') $releaseId
$releasesRoot = Join-Path $runtimeRoot 'releases'
if (Test-Path -LiteralPath $releasesRoot) {
    $releaseParent = Get-Item -LiteralPath $releasesRoot -Force
    if (-not $releaseParent.PSIsContainer -or ($releaseParent.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Release parent must be a normal directory.' }
}
New-Item -ItemType Directory -Path $releaseRoot | Out-Null
$archivePath = Join-Path $releaseRoot 'whisper-bin-x64.zip'
$binaryRoot = Join-Path $releaseRoot 'bin'
$modelPath = Join-Path $releaseRoot 'ggml-base.bin'

Write-Host 'Downloading pinned official whisper.cpp Windows CPU runtime (8.2 MiB) and multilingual base model (141.1 MiB).'
Invoke-WebRequest -Uri $archiveUrl -OutFile $archivePath
if ((Get-Item -LiteralPath $archivePath).Length -ne 8573270 -or (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $archiveSha) { throw 'Official runtime archive verification failed. No runtime was activated.' }

# Validate every ZIP entry before extraction, including Windows alternate data
# streams, absolute paths, traversal, case-insensitive collisions, and symlinks.
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    if ($zip.Entries.Count -gt 2000) { throw 'Runtime archive has too many entries.' }
    $totalBytes = 0L
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $zip.Entries) {
        $relative = $entry.FullName.Replace('\', '/')
        if (-not $relative -or $relative.StartsWith('/') -or $relative.Contains(':') -or $relative.Contains([char]0) -or $relative -match '[<>"|?*]' -or ($relative.TrimEnd('/') -split '/' | Where-Object { $_ -eq '..' -or $_ -eq '.' -or $_ -eq '' }).Count -gt 0) { throw 'Unsafe path in runtime archive.' }
        if (@($relative.TrimEnd('/') -split '/' | Where-Object { $_ -match '[. ]$' -or $_ -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)' }).Count -gt 0) { throw 'Unsafe Windows name in runtime archive.' }
        if (-not $seen.Add($relative.TrimEnd('/'))) { throw 'Duplicate path in runtime archive.' }
        if (((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) -or ($entry.ExternalAttributes -band [int][IO.FileAttributes]::ReparsePoint)) { throw 'Links are not permitted in runtime archive.' }
        $target = [IO.Path]::GetFullPath((Join-Path $binaryRoot $relative))
        if (-not $target.StartsWith($binaryRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime archive path escaped extraction directory.' }
        $totalBytes += $entry.Length
        if ($totalBytes -gt 268435456) { throw 'Runtime archive is unexpectedly large.' }
    }
} finally { $zip.Dispose() }
[IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $binaryRoot)
Invoke-WebRequest -Uri $modelUrl -OutFile $modelPath
if ((Get-Item -LiteralPath $modelPath).Length -ne $modelSize -or (Get-FileHash -LiteralPath $modelPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $modelSha) { throw 'Speech model verification failed. No runtime was activated.' }
$executables = @(Get-ChildItem -LiteralPath $binaryRoot -Recurse -File -Filter 'whisper-cli.exe')
if ($executables.Count -ne 1) { throw 'Expected exactly one official whisper-cli executable.' }

function Get-RelativeRuntimePath([string]$Absolute) {
    $resolved = [IO.Path]::GetFullPath($Absolute)
    if (-not $resolved.StartsWith($runtimeRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Generated runtime path is out of bounds.' }
    return $resolved.Substring($runtimeRoot.Length + 1).Replace('\', '/')
}
$files = @()
foreach ($item in @(Get-ChildItem -LiteralPath $binaryRoot -Recurse -File | Where-Object { $_.Extension -in '.exe', '.dll' }) + @(Get-Item -LiteralPath $modelPath)) {
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked runtime files are not allowed.' }
    $files += [ordered]@{path=(Get-RelativeRuntimePath $item.FullName);sha256=(Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant();bytes=$item.Length}
}
$manifest = [ordered]@{
    schemaVersion=1; engine='whisper.cpp';version='1.9.4';build='b5130';
    sourceCommit='927cfce34f31707e17f2bff35c349632fb9e2c3a';
    archive=[ordered]@{url=$archiveUrl;sha256=$archiveSha;bytes=8573270};
    model=[ordered]@{path=(Get-RelativeRuntimePath $modelPath);name='base';multilingual=$true;url=$modelUrl;sha256=$modelSha;bytes=$modelSize};
    executable=(Get-RelativeRuntimePath $executables[0].FullName);files=$files
}
$pendingManifest = Join-Path $releaseRoot 'runtime.pending.json'
[IO.File]::WriteAllText($pendingManifest, ($manifest | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
if (Test-Path -LiteralPath $manifestPath) {
    $backupPath = Join-Path $runtimeRoot ('runtime.backup-' + [Guid]::NewGuid().ToString('N') + '.json')
    [IO.File]::Replace($pendingManifest, $manifestPath, $backupPath)
} else {
    [IO.File]::Move($pendingManifest, $manifestPath)
}
# The archive is our exact generated and verified download, not a user file.
Remove-Item -LiteralPath $archivePath
Write-Host 'Pinned local dictation runtime installed. Previous runtime files, if any, were preserved. No microphone was used and no inference was run.'
