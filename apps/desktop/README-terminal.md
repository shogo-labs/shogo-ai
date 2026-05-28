# Desktop Terminal

Cursor-parity terminal for the Shogo desktop app.

This document is the integration reference for the `apps/desktop` package — it explains how the pieces fit, where each Phase 1–10 module lives, and what wiring the app shell is expected to provide.

For day-to-day end-user docs (keyboard shortcuts, profile authoring), see the in-app Help → Terminal pane.

---

## 1. Architecture at a glance

```
┌──────────────────────────────────────────────────────────────────────┐
│ Renderer (React + xterm.js)                                          │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ @shogo/desktop-terminal (this package)                       │    │
│  │   ├─ DesktopPtyClient  (Phase 2)                             │    │
│  │   ├─ Osc633Tracker     (Phase 3)                             │    │
│  │   ├─ CommandDecorations / Navigation / StickyScroll (Phase 4)│    │
│  │   ├─ Search / GPU / Splits / Profiles / WriteBatcher (Ph 5)  │    │
│  │   ├─ CwdLinkProvider / drag-drop / RecentPickers (Phase 6)   │    │
│  │   ├─ QuickFixEngine / QuickFixManager (Phase 7)              │    │
│  │   ├─ ApprovalStore / Debug-with-AI / CmdKController (Ph 8)   │    │
│  │   ├─ RestoreCoordinator (Phase 9)                            │    │
│  │   └─ SettingsStore / TelemetryEmitter (Phase 10)             │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                            ▲                                          │
│                            │  contextBridge (MessagePort)             │
└────────────────────────────┼──────────────────────────────────────────┘
                             │
┌────────────────────────────┴──────────────────────────────────────────┐
│ Main process (Electron)                                              │
│   ├─ terminal-ipc.ts (ipcMain handlers, port broker)                 │
│   └─ utilityProcess: pty-host                                        │
│        ├─ PtySession (node-pty wrapper)         (Phase 1)            │
│        ├─ shell-integration injector           (Phase 3)             │
│        └─ SnapshotStore (per-workspace JSON)   (Phase 9)             │
└──────────────────────────────────────────────────────────────────────┘
```

Three packages collaborate:

| Package | Role |
|---|---|
| `@shogo/pty-core` | OSC decoder, shared protocol types, scrollback ring |
| `@shogo/desktop-terminal` | Renderer-side: client, tracker, decorations, all UI logic |
| `apps/desktop` | Electron shell: main, preload, utilityProcess host, IPC wiring |

Mobile + web bundles **never** import `@shogo/desktop-terminal`; the import is gated behind `isDesktopRuntime()` in `pty-factory.ts`.

---

## 2. Module → Phase reference

Every file in `packages/desktop-terminal/src/renderer/` was added by a single phase. Use this when chasing a bug:

| Module | Phase | What it owns |
|---|---|---|
| `desktop-features.ts`, `desktop-pty-client.ts` | 2 | IPC bridge + PtyClient over MessagePort |
| `osc633-tracker.ts` | 3 | Folds OSC events into Command[] records |
| `command-decorations.ts` | 4 | ✓/✗/⏵/⏸ gutter glyphs + overview ruler |
| `command-navigation.ts` | 4 | ⌘↑/⌘↓ jumps between prompts |
| `sticky-scroll.tsx` | 4 | Running-command overlay |
| `background-process-warn.ts` | 4 | beforeunload safety net |
| `write-batcher.ts` | 5 | rAF coalescing for term.write() |
| `gpu-renderer.ts` | 5 | WebGL addon manager + flap detection |
| `search-popover.tsx` | 5 | ⌘F find-in-terminal |
| `splits-layout.tsx` | 5 | Binary-tree splits + draggable dividers |
| `profiles-store.ts` | 5 | Persisted shell profiles |
| `links/cwd-link-provider.ts` | 6 | Click `ls` output → open file |
| `drag-drop-paste.ts` | 6 | Drag file → POSIX-quoted path |
| `history/history-sources.ts` | 6 | Recent commands + directories |
| `pickers/recent-pickers.tsx` | 6 | Ctrl+Alt+R / ⌘G quick-pick UI |
| `quick-fix/` | 7 | Lightbulb on ✗ commands |
| `approval-store.ts` | 8 | Per-workspace allow/deny rules |
| `debug-with-ai.ts` | 8 | Bundle ✗ context → chat panel |
| `cmd-k-popover.tsx` | 8 | NL → shell command |
| `restore-notification.tsx` | 9 | Persistent-session restore toast |
| `settings-store.ts` | 10 | Typed user settings |
| `telemetry.ts` | 10 | Opt-in event emitter |

---

## 3. Shell integration mechanism

Phase 3 ships an OSC 633 / 133 / 1337 decoder plus a per-shell injector. The injector lives in `apps/desktop/src/pty-host/shell-integration/` and runs INSIDE the utility process before `node-pty.spawn()`.

### What we inject

| Shell | Mechanism | Files written to a per-session tmp dir |
|---|---|---|
| **bash** | `--rcfile <wrapper>` | `shogo-bashrc` (sources user rc files first, then ours), `shogo-bash-integration.sh` (DEBUG-trap pre-exec + appended `PROMPT_COMMAND`) |
| **zsh** | `ZDOTDIR=<tmp>` | `.zshenv` `.zprofile` `.zshrc` `.zlogin` `.zlogout` (all 5; each re-sources `$_SHOGO_ORIG_ZDOTDIR/<file>`) |
| **fish** | `XDG_CONFIG_HOME=<tmp>` | `fish/conf.d/shogo-integration.fish` + `00-shogo-passthrough.fish` (sources user's original `config.fish`) |
| **pwsh 7+** | `-NoExit -Command ". '<wrapper>'"` | `shogo-pwsh-profile.ps1` (dot-sources real $PROFILE files) + `shogo-pwsh-integration.ps1` (hooks PSReadLine + prompt()) |

Status codes the injector can return:

- `applied` — happy path
- `disabled-by-env` — user set `SHOGO_DISABLE_SHELL_INTEGRATION=1`
- `disabled-by-option` — settings panel toggled off
- `unsupported-shell` — `/bin/dash`, anonymous shells
- `windows-powershell-5` — pwsh 5.x is intentionally not supported; user gets a plain shell
- `conpty-too-old` — Win10 < build 19045 (older ConPTY drops OSC silently)

### The "VS Code broke my zsh" troubleshooting checklist

If a user reports a shell setup broken after enabling integration:

1. **Set `SHOGO_DISABLE_SHELL_INTEGRATION=1`** and verify the issue goes away. If it doesn't, the problem isn't us.
2. **Check `$ZDOTDIR`** — for zsh, the user's `_SHOGO_ORIG_ZDOTDIR` must reach their real dotfiles. If they manage zsh via a tool that ALSO sets `ZDOTDIR` (oh-my-zsh, Prezto), there can be ordering issues.
3. **Check `PROMPT_COMMAND` for bash** — we APPEND, never replace. If a user's `.bashrc` does `PROMPT_COMMAND='__mine'` (assignment, not append), our hook still runs but they may have lost something OTHER tools tried to append.
4. **Check `fish_prompt`** — we rename the user's function to `__shogo_user_fish_prompt`. If their `.config/fish/config.fish` redefines `fish_prompt` AFTER conf.d runs (unlikely but possible), they win.
5. **Look at the temp dir** — `ls /tmp/shogo-shell-*` shows exactly what we injected. The user can `cat` each file to see the wrappers we wrote.

---

## 4. Profile authoring

Profiles live in `userData/<…>/terminal-profiles.v1.json` and are managed by `ProfilesStore` (Phase 5).

Schema:

```jsonc
{
  "version": 1,
  "profiles": [
    {
      "id": "bash",                       // stable internal id
      "label": "bash",                    // shown in picker
      "shell": "/bin/bash",               // absolute path
      "args": ["-l"],                     // passed to node-pty.spawn()
      "env": { "FOO": "bar" },            // merged on top of process.env
      "cwd": "/Users/me/projects",        // optional; default = workspace root
      "icon": "bash",                     // hint string for app icons
      "isDefault": true                   // exactly ONE profile must be default
    }
  ]
}
```

Invariants the store enforces:
- exactly one `isDefault` (collapses extras to the first)
- unique ids (last write wins on dupe)
- can never be empty — `remove()` of the last profile re-seeds via the resolver

Auto-detection on first run uses the platform's `which`/registry search. The default resolver covers bash + zsh on macOS/Linux; apps/desktop's resolver also probes for fish, pwsh 7+, and Git Bash on Windows.

---

## 5. End-to-end test surface

`apps/desktop/e2e/terminal.spec.ts` covers the packaged-app happy path:

1. Launch the packaged Electron build
2. Open a terminal tab via the menu
3. Type `ls\r`, assert prompt + output rendered
4. Press ⌘K, assert popover visible, type prompt, accept suggestion
5. Run `false\r`, assert ✗ decoration appears on the row

The spec is **guarded** by `process.env.PLAYWRIGHT_E2E === '1'` so default CI (which doesn't have native node-pty) runs the unit suite only. The packaged-build matrix runs nightly under that env flag.

---

## 6. Frequently asked questions

**Q: Why doesn't my running process survive an app restart?**
A: It can't. node-pty owns a child OS process; once Electron exits, the OS reaps it. We persist the cwd + scrollback + shell config, then re-spawn a fresh shell on next boot. The Phase 9 restore toast says this explicitly: "Scrollback and working directory restored. Running processes did not survive the restart."

**Q: My GPU renderer is flapping. Help?**
A: Open Settings → Terminal → Renderer and uncheck "Use GPU acceleration". The app remembers across restarts. Phase 5's `GpuRenderer` already auto-disables after two context losses within 60 s; the toggle is for users who want canvas-only from the jump.

**Q: I want to ban the agent from running `rm -rf`. How?**
A: Settings → Terminal → Approvals → "Deny destructive commands" toggles in the `DESTRUCTIVE_DENIES` list from Phase 8. You can also write your own rules under Settings → Terminal → Approvals → Custom Rules; each rule is a JavaScript regex.

**Q: Telemetry?**
A: Off by default. Settings → Terminal → Telemetry shows the full list of events we'd send if you enabled it. No content, no command bodies — kinds + counts + shell names + exit codes only. See `packages/desktop-terminal/src/renderer/telemetry.ts` for the exhaustive list.

**Q: Where do I file a bug?**
A: `Settings → Help → Report a terminal issue` opens a pre-filled issue with the redacted `DebugContext` from Phase 8.

---

## 7. Outstanding integration items

These are the wiring touchpoints `apps/desktop` is expected to provide. None of them require code in `@shogo/desktop-terminal`; they are one-off plumbing.

1. **`terminal-ipc.ts`** — mount `SnapshotStore` (Phase 9) inside the utility-process host; hook session `lastSeq` updates to `update()`; drain in `beforeQuit`; expose `listSnapshots` / `restoreSession` / `discardSnapshot` over IPC for the renderer's `RestoreCoordinator`.
2. **`llm-ipc.ts`** — one handler that forwards `streamCommand` requests from `CmdKController` to the Shogo SDK's `client.llm`, and one handler for `openChatWithContext` that opens the chat panel with the markdown from `serialiseDebugContext`.
3. **`terminal-settings.tsx`** — shadcn-styled bindings for every field in `TerminalSettings`. Single-shot: each control calls `settingsStore.set({ field: value })`, listens via the store's `on(listener)`.
4. **Packaged-build matrix** — macOS arm64 + Linux x64 + Windows x64 under electron-forge. The native `node-pty` build is the only step that must succeed before `apps/desktop/npm install` lands.
