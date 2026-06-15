# Shogo Core Extension

Buildable Phase 3 shell for the bundled Shogo IDE extension.

The extension stays portable enough to run in stock VS Code during development and in the Shogo Code - OSS distribution when bundled.

## Phase 3 responsibilities

- Own the Shogo activity bar container.
- Register the Chat webview view.
- Register Agent Tasks, Checkpoints, Runtime, and Integrations tree views.
- Register command IDs and menu placement.
- Collect selected text and active file context.
- Check local Shogo agent service health when configured.
- Keep heavy work out of the extension host.

## Commands

```text
shogo.chat.focus
shogo.health.check
shogo.context.addSelection
shogo.context.addActiveFile
shogo.context.clear
shogo.patch.preview
shogo.checkpoint.create
shogo.git.reviewChanges
shogo.runtime.openPreview
```

## Runtime contract

The extension talks to a future local Shogo agent service over localhost HTTP. The service owns indexing, patch application, checkpointing, command execution, and model/tool orchestration.

Phase 3 supports:

- `GET /health`
- `POST /chat`

If no service URL is configured, the chat webview returns a local placeholder response so the UI can be tested safely.

## Security rules

- Never run shell commands in Phase 3.
- Never apply edits in Phase 3.
- Gate patch/checkpoint/source-control actions on workspace trust.
- Validate webview message types before acting.
- Truncate selected/active-file context before storing it.
- Never send ignored/secret files as context by default.
