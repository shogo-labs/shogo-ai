# shogo-sysaudio

Minimal macOS system-audio capture helper used by Shogo Desktop.

Chromium has no portable API for capturing arbitrary system audio on
macOS (`getDisplayMedia` only works on Windows for that). This helper
fills the gap: it is the smallest possible Swift executable that drives
ScreenCaptureKit's audio-only shareable-content path and streams the
resulting PCM on stdout. Everything else (mic capture, WAV writing,
meeting detection, UI) is handled in Node/Electron.

## Protocol

- stdin: newline-delimited commands
  - `start` — start capturing system audio
  - `stop` — stop capturing (helper keeps running so you can start again)
  - `quit` — exit cleanly
- stdout: raw PCM stream (48 kHz, stereo, 16-bit little-endian, interleaved)
- stderr: newline-delimited JSON control events
  - `{ "type": "ready" }` — process is ready to accept commands
  - `{ "type": "started", "sampleRate": 48000, "channels": 2, "bitsPerSample": 16 }`
  - `{ "type": "stopped", "frames": <samples-per-channel> }`
  - `{ "type": "error", "message": "..." }`
  - `{ "type": "warning", "message": "..." }`

## Build

```
cd apps/desktop/native/shogo-sysaudio
make build              # arm64 only
make build-universal    # arm64 + x86_64 (shipping builds)
```

## Permissions

First run of the helper triggers the macOS Screen Recording TCC prompt.
Deny once and system-audio capture silently degrades — the helper emits a
`warning` event so the caller can surface this to the user.
