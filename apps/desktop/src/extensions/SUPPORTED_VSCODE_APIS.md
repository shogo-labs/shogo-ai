# Supported VS Code API surface

The Shogo extension host implements a **subset** of the VS Code extension API.
`engines.vscode` is only a coarse version gate (`SHOGO_VSCODE_COMPATIBILITY`);
real compatibility depends on whether the contribution points and activation
events an extension declares are actually backed by the host.

The source of truth is `manifest.ts`:

- `SUPPORTED_CONTRIBUTION_POINTS` — wired to real runtime behavior.
- `PASSIVE_CONTRIBUTION_POINTS` — consumed by the editor (Monaco) as assets.
- `UNIMPLEMENTED_CONTRIBUTION_POINTS` — recognized in schema, not implemented.
- `SUPPORTED_ACTIVATION_EVENTS` — activation-event prefixes the host can fire.

`normalizeExtensionManifest()` reports `compatible`, `compatibilityReason`,
`unsupportedContributions`, and `unsupportedActivationEvents` so the UI can show
accurate "compatible / compatible with limitations / incompatible" states
instead of a blanket version claim.

## Contribution points

| Point | Status |
| --- | --- |
| `commands` | Supported |
| `menus` | Supported |
| `keybindings` | Supported |
| `views` | Supported |
| `viewsContainers` | Supported |
| `viewsWelcome` | Supported |
| `configuration` | Supported |
| `languages`, `grammars`, `snippets`, `themes`, `iconThemes`, `productIconThemes`, `jsonValidation` | Passive (editor-consumed) |
| `debuggers`, `breakpoints`, `taskDefinitions`, `terminal`, `walkthroughs` | Not implemented |

## Activation events

Supported: `*`, `onStartupFinished`, `onCommand:*`, `onView:*`,
`workspaceContains:*`, `onLanguage:*`.

Anything else (e.g. `onDebug*`, `onTaskType:*`, `onUri`, `onFileSystem:*`)
cannot be fired and is reported in `unsupportedActivationEvents`.

## `vscode` API runtime

The synthetic `vscode` module (`makeVscodeApi`) is created **once per extension**
and cached, so a lazy `require('vscode')` from a command/event handler after the
activation window still resolves to the correct extension's API.

## Restricted (untrusted) workspaces

Extensions with only `limited` untrusted-workspace support run in restricted
mode: dangerous Node builtins (`child_process`, `net`, `tls`, `http(s)`, …) are
denied and `fs` is wrapped read-only. See `extension-host-runner.ts`.
