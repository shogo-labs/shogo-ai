# Phase 5 Replace Current Custom IDE Pieces

Phase 5 changes Shogo Desktop from "custom Monaco workbench with Shogo IDE preview overlay" to "Shogo IDE first, Monaco workbench as legacy fallback".

## What changed

The existing IDE tab now checks for the Electron preload bridge:

```ts
window.shogoDesktop.shogoIde
```

When that bridge exists inside Shogo Desktop, the IDE tab renders `ShogoIdeReplacementGate` by default instead of mounting the custom Monaco `Workbench`. Web and mobile do not enter this Shogo IDE replacement path.

Desktop opens Shogo IDE automatically from the IDE tab. The replacement gate only remains visible while Desktop is preparing or if launch diagnostics need to be shown.

The replacement gate lets users:

- retry opening the Code OSS-based Shogo IDE,
- see automatic setup/launch diagnostics,
- explicitly open the old Monaco workbench as **Legacy Monaco IDE**.

## Files

```text
apps/mobile/components/project/panels/IDEPanel.tsx
apps/mobile/components/project/panels/ide/ShogoIdeReplacementGate.tsx
```

## Behavior matrix

| Environment | Default IDE behavior |
| --- | --- |
| Shogo Desktop with `window.shogoDesktop.shogoIde` | Automatically opens Shogo IDE; shows diagnostics only if preparation/launch is blocked |
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
- If Code OSS source setup is incomplete, Desktop starts the setup automatically and shows diagnostics instead of manual commands.

## Safety

- No Code OSS source is vendored.
- Desktop opens Shogo IDE automatically from the IDE tab and may run setup automatically when local source metadata is missing.
- Existing web/mobile behavior remains intact and does not use the Shogo IDE replacement path.
- Existing Workbench code is not deleted in Phase 5.
- The current desktop menu launch path remains available.

## Remaining work after Phase 5

- Build/package the actual Code OSS checkout.
- Wire Code OSS package output into `SHOGO_IDE_EXECUTABLE` discovery automatically.
- Add local agent service process supervision.
- Migrate source-control, terminal, runtime, and checkpoint features into `shogo-core` + agent service.
- Eventually remove legacy Monaco desktop fallback after beta confidence.
