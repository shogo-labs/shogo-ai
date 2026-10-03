# shogo-hotkey

macOS helper that gives Shogo Desktop a global push-to-talk key.

Electron's `globalShortcut` cannot bind the `Fn` key or observe key release,
both of which hold-to-dictate needs. This helper runs a `CGEventTap`, reports
when a configured chord is pressed and released, and can post Cmd+V so the
dictated text lands in whichever app has focus.

## Protocol

- argv: `--push-to-talk=<chord>` (optional). Chords look like `fn` or
  `control+option+space`. A chord needs at least one modifier. `none` disables it.
- stdin: newline-delimited commands
  - `set <chord|none>` change the chord
  - `paste` post Cmd+V to the focused app
  - `quit` exit (the helper also exits when stdin closes)
- stdout: newline-delimited JSON events
  - `{"event":"ready"}`
  - `{"event":"waiting","reason":"not-trusted"}` Accessibility is not granted yet; retrying every 2s
  - `{"event":"listening","chord":"fn"}`
  - `{"event":"ptt","down":true}` / `{"event":"ptt","down":false}`
  - `{"event":"combo"}` another key joined an Fn hold (for example Fn+Arrow), so ignore this hold
  - `{"event":"pasted"}`
  - `{"event":"error","message":"..."}`

## Build

```
cd apps/desktop/native/shogo-hotkey
make build              # arm64 only
make build-universal    # arm64 + x86_64 (shipping builds)
```

## Permissions

The event tap needs Accessibility, granted to Shogo (the helper's responsible
parent process). Until it is granted the helper stays alive and retries.

On recent Macs the Globe key doubles as Fn. If it opens the emoji picker or
system dictation, set System Settings > Keyboard > "Press Globe key to" to
"Do Nothing".
