# Local recorder helper

`SmoothPdfRecorder.exe` is a Windows-only, plugin-owned, headless microphone recorder. It uses Windows WASAPI shared mode and the default capture endpoint. It never records system playback, changes Windows privacy settings, or falls back to another capture API after denial. Capture data stays in bounded memory; the helper creates no audio files, native windows or network connections. Recording and cancellation controls remain inside the PDF comment popup.

Build and run non-recording tests with `build-recorder.ps1`. The installed .NET Framework compiler is sufficient. The generated `bin/recorder-manifest.json` records the exact executable hash and source hash. `--self-test` performs synthetic conversion, strict-parser and pre-capture cancellation tests only. Additional source guards prohibit visible forms or automatic capture, and an actual idle-process smoke test verifies no visible main window, no active session, and a clean shutdown. Tests never send a start command or open an audio device.

## Process launch

Launch hidden with redirected stdin/stdout, without a shell:

```
SmoothPdfRecorder.exe --parent-pid <owning-process-id>
```

The helper emits `{"event":"ready","protocolVersion":1,"interactionMode":"inline-only"}` without touching the microphone. It creates only a hidden command dispatcher and watchdog timer. Parent exit or stdin EOF discards any active capture and exits. Each explicit start command is sent only after the user's inline microphone action and proceeds directly to `recording` or a sanitized error. There is no separate native consent dialog. Merely launching or installing the plugin never starts capture, and Windows microphone privacy permissions are never changed or assumed granted.

## NDJSON commands

Each command occupies one line, at most 256 characters. The strict grammar accepts `op` first and `sessionId` second, with no additional fields. Session identifiers must contain 16–80 ASCII letters, digits, underscores or hyphens.

```
{"op":"start","sessionId":"<opaque-session-id>"}
{"op":"heartbeat","sessionId":"<same-session-id>"}
{"op":"stop","sessionId":"<same-session-id>"}
{"op":"cancel","sessionId":"<same-session-id>"}
{"op":"shutdown"}
```

Start arms an eight-second heartbeat lease. The controlling reader must keep renewing it while the popup and session are live. Lease expiration cancels and discards; it never returns PCM. Stop ends capture and returns PCM. Cancel, closing the reader popup, shutdown, parent exit and stdin EOF discard the recording. The plugin must send cancel on Escape or document changes and must stop renewing the heartbeat if the popup disappears. A named local-session mutex prevents concurrent capture by multiple reader helper processes.

## Events

Except for `ready` and malformed-command errors, events echo the active `sessionId`:

- `recording`: WASAPI successfully started.
- `stopped`: microphone closed, with `pcmBase64`, integer `samples`, and `seconds`.
- `cancelled`: capture cancelled; contains no audio.
- `error`: sanitized `code` and `message`, with no transcript, audio, device identity or filesystem paths.

The sole PCM format is little-endian signed 16-bit, mono, 16 kHz. Output is capped at 1,920,000 samples (3,840,000 bytes / 120 seconds). Supported input formats are PCM8/16/24/32 and float32/64, 1–32 channels, 8–192 kHz. Channels are averaged and rate conversion uses a windowed-sinc antialias filter; packet boundaries do not change output.

The recorder releases its microphone before emitting `stopped`. The owner must discard stale responses, bind results to the originating PDF/draft, transcribe locally, and avoid logging PCM or transcripts. Real microphone tests require the user's explicit inline microphone action; automated tests must never send a live start command.
