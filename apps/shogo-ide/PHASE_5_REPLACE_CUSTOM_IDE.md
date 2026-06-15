# Phase 5 Replace Current Custom IDE Pieces

Phase 5 changes Shogo Desktop from "custom Monaco workbench with Shogo IDE preview overlay" to "Shogo IDE first, Monaco workbench as legacy fallback".

## What changed

The existing IDE tab now checks for the Electron preload bridge:

```ts
window.shogoDesktop.shogoIde
```

When that bridge exists, the IDE tab renders `ShogoIdeReplacementGate` by default instead of mounting the custom Monaco `Workbench`.

The replacement gate lets users:

- open the Code OSS-based Shogo IDE,
- reveal the Shogo IDE distribution files,
- see setup status and clone command,
- explicitly open the old Monaco workbench as **Legacy Monaco IDE**.

## Files

```text
apps/mobile/components/project/panels/IDEPanel.tsx
apps/mobile/components/project/panels/ide/ShogoIdeReplacementGate.tsx
```

## Behavior matrix

| Environment | Default IDE behavior |
| --- | --- |
| Shogo Desktop with `window.shogoDesktop.shogoIde` | Shogo IDE replacement gate |
| Shogo Desktop after user chooses legacy | Legacy Monaco Workbench with return banner |
| Web browser without desktop bridge | Existing Monaco Workbench |
| Native mobile | Existing placeholder |

## Why this replaces without deleting

The old Monaco IDE is still valuable during migration and for non-desktop surfaces. Phase 5 stops treating it as the primary Desktop IDE while avoiding a risky hard deletion.

This means the following custom desktop IDE pieces are no longer the default Desktop path:

- Monaco editor workbench shell,
- custom activity bar,
- custom editor tabs,
- custom source-control viewlet,
- custom terminal panel,
- custom command palette,
- custom LSP/editor model sync.

They are now behind explicit legacy mode on Desktop and remain available for web fallback/mobile-adjacent scenarios.

## User escape hatches

- **Use Legacy Monaco IDE** opens the old embedded workbench.
- **Return to Shogo IDE** clears the legacy preference and returns to the replacement gate.
- If Code OSS is not cloned/built yet, the gate shows the setup command instead of failing.

## Safety

- No Code OSS source is vendored.
- No executable launches until the user clicks **Open Shogo IDE**.
- Existing web/mobile behavior remains intact.
- Existing Workbench code is not deleted in Phase 5.
- The current desktop menu launch path remains available.

## Remaining work after Phase 5

- Build/package the actual Code OSS checkout.
- Wire Code OSS package output into `SHOGO_IDE_EXECUTABLE` discovery automatically.
- Add local agent service process supervision.
- Migrate source-control, terminal, runtime, and checkpoint features into `shogo-core` + agent service.
- Eventually remove legacy Monaco desktop fallback after beta confidence.
