# Phase 5 Replace Current Custom IDE Pieces

Phase 5 now uses "Monaco workbench first, Shogo IDE as an explicit launcher" so opening the IDE tab stays lightweight and predictable.

## What changed

The existing IDE tab now uses the Electron preload workbench bridge:

```ts
window.shogoDesktop.codeWorkbench
```

IDE tab now keeps Monaco visible and opens/focuses the managed Shogo-IDE window. Web and mobile continue to use their existing Monaco/placeholder behavior and never render the desktop-only Shogo IDE action.

Users can also open/focus the managed Code OSS-based Shogo-IDE window through the small top-right button in the Monaco IDE panel.

The compact action lets users:

- open/focus the Code OSS-based Shogo-IDE window for the resolved project folder,
- keep editing in Monaco while Shogo-IDE opens separately,
- return to the already-open Shogo-IDE window without creating duplicates.

## Files

```text
apps/mobile/components/project/panels/IDEPanel.tsx
apps/mobile/app/(app)/projects/[id]/_layout.tsx
apps/mobile/components/project/ProjectTopBar.tsx
apps/desktop/src/ide-views.ts
```

## Behavior matrix

| Environment | Default IDE behavior |
| --- | --- |
| Shogo Desktop with `window.shogoDesktop.codeWorkbench` | Existing Monaco Workbench with a small top-right **Open Shogo IDE** button and IDE-tab open/focus behavior |
| Shogo Desktop File menu | **Open Shogo IDE...** launches the Code OSS-based IDE on demand |
| Web browser without desktop bridge | Existing Monaco Workbench |
| Native mobile | Existing placeholder |

## Why this replaces without deleting

The Monaco IDE is still valuable for fast in-app edits, non-desktop surfaces, and a safe fallback while Shogo IDE matures. Phase 5 stops forcing Code OSS on every IDE tab switch while avoiding a risky hard deletion.

This means the following custom desktop IDE pieces remain the default in-tab editing path:

- Monaco editor workbench shell,
- custom activity bar,
- custom editor tabs,
- custom source-control viewlet,
- custom terminal panel,
- custom command palette,
- custom LSP/editor model sync.

They stay available on Desktop, web fallback, and mobile-adjacent scenarios. Code OSS launches separately when requested.

## User entry points

- The IDE tab shows Monaco immediately and keeps live-edit subscriptions mounted across tab switches.
- **Open Shogo IDE** in the top-right corner opens Code OSS for the resolved project folder.
- If Code OSS source setup is incomplete, Desktop starts setup only after the user requests Shogo IDE and shows diagnostics instead of manual commands.

## Safety

- No Code OSS source is vendored.
- Desktop keeps Monaco visible when the IDE tab opens/focuses Shogo-IDE.
- Existing web/mobile behavior remains intact and does not render the desktop-only launcher.
- Existing Workbench code remains the default in-app editing path.
- The old standalone Code - OSS / Extension Development Host launcher is removed; Desktop uses the managed Shogo-IDE window only.

## Remaining work after Phase 5

- Keep the managed Shogo-IDE web workbench path as the only Desktop Code OSS launch surface.
- Add local agent service process supervision.
- Migrate source-control, terminal, runtime, and checkpoint features into `shogo-core` + agent service.
