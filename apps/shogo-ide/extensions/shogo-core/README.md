# Shogo Core Extension

Bundled Shogo IDE extension for the managed Code - OSS workbench.

The extension stays portable enough to run in stock VS Code during development and in the Shogo Code - OSS distribution when bundled.

## Responsibilities

- Own the right-side Shogo Chat webview container.
- Embed the Desktop project chat route inside the workbench.
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

The extension can talk to a local Shogo agent service over localhost HTTP. The service owns indexing, patch application, checkpointing, command execution, and model/tool orchestration.

Supported endpoints:

- `GET /health`
- `POST /chat`

If no service URL is configured, the chat webview stays usable and reports that the local bridge is unavailable.

## Security rules

- Do not run shell commands directly from the extension host.
- Do not apply edits directly from the extension host.
- Gate patch/checkpoint/source-control actions on workspace trust.
- Validate webview message types before acting.
- Truncate selected/active-file context before storing it.
- Never send ignored/secret files as context by default.
