param([switch]$SkipTests)
$ErrorActionPreference = 'Stop'
$recorderRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$sourcePath = Join-Path $recorderRoot 'SmoothPdfRecorder.cs'
$outputDirectory = Join-Path $recorderRoot 'bin'
$executablePath = Join-Path $outputDirectory 'SmoothPdfRecorder.exe'
$compilerPath = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compilerPath -PathType Leaf)) { throw 'The Windows .NET Framework C# compiler was not found.' }
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw 'Recorder source file was not found.' }
if (-not (Test-Path -LiteralPath $outputDirectory)) { New-Item -ItemType Directory -Path $outputDirectory | Out-Null }
& $compilerPath /nologo /target:winexe /platform:x64 /optimize+ /warnaserror+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/out:$executablePath" $sourcePath
if ($LASTEXITCODE -ne 0) { throw 'Recorder compilation failed.' }
if (-not $SkipTests) { & (Join-Path $recorderRoot 'test-recorder.ps1') }
$manifest = [ordered]@{
    schemaVersion = 1
    protocolVersion = 1
    executable = 'SmoothPdfRecorder.exe'
    sha256 = (Get-FileHash -LiteralPath $executablePath -Algorithm SHA256).Hash.ToLowerInvariant()
    bytes = (Get-Item -LiteralPath $executablePath).Length
    sourceSha256 = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
    captureApi = 'Windows WASAPI shared-mode default capture endpoint'
    sampleRate = 16000
    channels = 1
    pcmBits = 16
    maxSeconds = 120
    leaseMilliseconds = 8000
    interactionMode = 'inline-only'
    activation = 'explicit-inline-button'
    requiresNativeConsent = $false
    nativeWindows = $false
    startsOnlyOnExplicitCommand = $true
}
# Generated build manifest, not a source edit.
[IO.File]::WriteAllText((Join-Path $outputDirectory 'recorder-manifest.json'), ($manifest | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$manifest | ConvertTo-Json
