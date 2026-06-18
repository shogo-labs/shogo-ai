# Phase 5 Replace Current Custom IDE Pieces

Phase 5 now uses "Monaco workbench first, Shogo IDE as an explicit launcher" so opening the IDE tab stays lightweight and predictable.

## What changed

The existing IDE tab now checks for the Electron preload bridge:

```ts
window.shogoDesktop.shogoIde
```

When that bridge exists inside Shogo Desktop, the IDE tab still mounts the Monaco `Workbench` by default and overlays a small top-right `ShogoIdeReplacementGate` action. Web and mobile continue to use their existing Monaco/placeholder behavior and never render the desktop-only Shogo IDE action.

Desktop does not open Shogo IDE automatically from the IDE tab. Users open the Code OSS-based Shogo IDE explicitly through the small top-right button or through the macOS **File → Open Shogo IDE...** menu item.

The compact launcher lets users:

- open the Code OSS-based Shogo IDE for the resolved project folder,
- keep editing in Monaco while Shogo IDE opens separately,
- see a small setup/launch message only when a launch is requested or fails.

## Files

```text
apps/mobile/components/project/panels/IDEPanel.tsx
apps/mobile/components/project/panels/ide/ShogoIdeReplacementGate.tsx
```

## Behavior matrix

| Environment | Default IDE behavior |
| --- | --- |
| Shogo Desktop with `window.shogoDesktop.shogoIde` | Existing Monaco Workbench with a small top-right **Open Shogo IDE** button |
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
- **File → Open Shogo IDE...** opens Code OSS from the native macOS menu.
- If Code OSS source setup is incomplete, Desktop starts setup only after the user requests Shogo IDE and shows diagnostics instead of manual commands.

## Safety

- No Code OSS source is vendored.
- Desktop does not open Shogo IDE automatically from the IDE tab.
- Existing web/mobile behavior remains intact and does not render the desktop-only launcher.
- Existing Workbench code remains the default in-app editing path.
- The current desktop menu launch path remains available as **Open Shogo IDE...**.

## Remaining work after Phase 5

- Build/package the actual Code OSS checkout.
- Wire Code OSS package output into `SHOGO_IDE_EXECUTABLE` discovery automatically.
- Add local agent service process supervision.
- Migrate source-control, terminal, runtime, and checkpoint features into `shogo-core` + agent service.
- Eventually remove legacy Monaco desktop fallback after beta confidence.
