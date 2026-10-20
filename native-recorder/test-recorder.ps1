$ErrorActionPreference = 'Stop'
$executablePath = Join-Path $PSScriptRoot 'bin\SmoothPdfRecorder.exe'
if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) { throw 'Build the recorder before testing.' }
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $executablePath
$start.Arguments = '--self-test'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$process = [Diagnostics.Process]::new()
$process.StartInfo = $start
try {
    if (-not $process.Start()) { throw 'Recorder test process did not start.' }
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(60000)) { $process.Kill(); throw 'Recorder self-test exceeded 60 seconds.' }
    $output = $stdout.GetAwaiter().GetResult()
    $errorOutput = $stderr.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) { throw "Recorder self-test failed: $output $errorOutput" }
    $result = $output.Trim() | ConvertFrom-Json
    if ($result.event -ne 'self-test' -or $result.microphoneOpened -ne $false -or $result.passed -lt 14) { throw 'Unexpected recorder self-test result.' }
    $output.Trim()
} finally { $process.Dispose() }

# Static guards supplement the real idle-process smoke test: never instantiate or
# show native UI, emit a consent state, or activate capture from the constructor.
$source = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'SmoothPdfRecorder.cs') -Raw
if ($source -match '\bnew\s+(Form|Button|Label)\b') { throw 'A native UI component was reintroduced.' }
if ($source -match '\.(Show|ShowDialog)\s*\(|(?:window|form|dispatcher)\.Activate\s*\(') { throw 'A native visibility call was reintroduced.' }
if ($source -match 'Emit\("consent"') { throw 'A native consent event was reintroduced.' }
$constructorStart = $source.IndexOf('internal RecorderContext(int parentId)')
$constructorEnd = $source.IndexOf('private void Dispatch(Action action)', $constructorStart)
if ($constructorStart -lt 0 -or $constructorEnd -le $constructorStart) { throw 'Recorder constructor guard could not be checked.' }
$constructor = $source.Substring($constructorStart, $constructorEnd - $constructorStart)
if ($constructor -match 'BeginCapture\(|new CaptureWorker|GetDefaultAudioEndpoint|client\.Start\(') { throw 'Capture was reintroduced at startup.' }
if ([regex]::Matches($source, 'BeginCapture\(').Count -ne 2) { throw 'Capture must have exactly one explicit command entry point.' }
if ($source -notmatch 'dispatcher\.Visible\s*=\s*false') { throw 'The command dispatcher must be hidden.' }
'{"event":"headless-source-guards","passed":6}'

# Start normally, inspect only process visibility, exercise a non-start command,
# and stop. No test sends start, creates a consent dialog, or opens a microphone.
$idleStart = [Diagnostics.ProcessStartInfo]::new()
$idleStart.FileName = $executablePath
$idleStart.Arguments = "--parent-pid $PID"
$idleStart.UseShellExecute = $false
$idleStart.CreateNoWindow = $true
$idleStart.RedirectStandardInput = $true
$idleStart.RedirectStandardOutput = $true
$idleStart.RedirectStandardError = $true
$idle = [Diagnostics.Process]::new()
$idle.StartInfo = $idleStart
$idleStarted = $false
try {
    $idleStarted = $idle.Start()
    if (-not $idleStarted) { throw 'Headless recorder did not start.' }
    $readyTask = $idle.StandardOutput.ReadLineAsync()
    if (-not $readyTask.Wait(5000)) { throw 'Headless recorder ready event timed out.' }
    $ready = $readyTask.Result | ConvertFrom-Json
    if ($ready.event -ne 'ready' -or $ready.protocolVersion -ne 1 -or $ready.interactionMode -ne 'inline-only') { throw 'Unexpected headless recorder handshake.' }
    $idle.Refresh()
    if ($idle.MainWindowHandle -ne [IntPtr]::Zero -or $idle.MainWindowTitle.Length -ne 0) { throw 'Headless recorder created a visible native window.' }
    $idle.StandardInput.WriteLine('{"op":"heartbeat","sessionId":"headless_smoke_12345"}')
    $idle.StandardInput.Flush()
    $errorTask = $idle.StandardOutput.ReadLineAsync()
    if (-not $errorTask.Wait(5000)) { throw 'Headless recorder command dispatch timed out.' }
    $response = $errorTask.Result | ConvertFrom-Json
    if ($response.event -ne 'error' -or $response.code -ne 'STALE_SESSION') { throw 'Idle recorder incorrectly entered a recording state.' }
    $idle.StandardInput.WriteLine('{"op":"shutdown"}')
    $idle.StandardInput.Flush()
    if (-not $idle.WaitForExit(5000) -or $idle.ExitCode -ne 0) { throw 'Headless recorder did not shut down normally.' }
    '{"event":"headless-idle-smoke","passed":4,"visibleWindow":false,"microphoneRequested":false}'
} finally {
    if ($idleStarted -and -not $idle.HasExited) { $idle.Kill(); [void]$idle.WaitForExit(2000) }
    $idle.Dispose()
}
