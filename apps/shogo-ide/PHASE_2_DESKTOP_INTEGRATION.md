# Phase 2 Desktop Integration

Phase 2 wires the `apps/shogo-ide` Code - OSS spike into the existing Shogo Desktop app without replacing the current Monaco IDE.

## What is integrated

- Electron main process registers `shogo-ide:*` IPC handlers.
- Electron preload exposes `window.shogoDesktop.shogoIde`.
- The current IDE tab renders a small desktop-only Shogo IDE launcher over the Monaco workbench.
- The File menu includes an **Open Shogo IDE...** action.
- The launcher reports setup status when Code - OSS has not been cloned/built yet.

## Current behavior

The existing Monaco IDE remains mounted and fully usable. Phase 5 now keeps Monaco as the default Desktop IDE tab and exposes Shogo IDE through a compact explicit launcher.

Desktop can start Shogo IDE setup after the user chooses **Open Shogo IDE** and the Code OSS checkout or generated distribution metadata is missing. It still returns a clear diagnostic if no executable is available yet.

## IPC contract

```ts
window.shogoDesktop.shogoIde.getStatus()
window.shogoDesktop.shogoIde.launch({ workspacePath?: string })
window.shogoDesktop.shogoIde.openWorkspaceFolder()
```

Main-process channels:

```text
shogo-ide:get-status
shogo-ide:launch
shogo-ide:open-workspace-folder
```

## Safety decisions

- No current `apps/desktop` runtime is replaced.
- No Code - OSS source is vendored.
- Desktop spawns setup/launch processes only after the user chooses the explicit Shogo IDE action; web and mobile never render this desktop-only launcher.
- `SHOGO_IDE_EXECUTABLE` can override executable discovery for local tests.
- `SHOGO_REPO_ROOT` or `SHOGO_IDE_REPO_ROOT` can override repo-root discovery for packaged/dev edge cases.
- The new protocol remains `shogo-ide://` in the product template, separate from current `shogo://app`.

## Edge cases covered

- Missing Phase 1 files.
- Code - OSS not cloned.
- Code - OSS cloned but not built.
- Packaged app path not equal to monorepo path.
- User data folder collision avoided via `.shogo-ide`.
- Current IDE remains fallback if launch fails.

## Next required work

Phase 3 should make `shogo-core` a real VS Code extension build with:

- extension bundling,
- chat webview shell,
- command registration tests,
- local agent service health check,
- selected text context plumbing.
