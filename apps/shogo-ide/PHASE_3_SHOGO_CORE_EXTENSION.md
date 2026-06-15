# Phase 3 Shogo Core Extension

Phase 3 turns `apps/shogo-ide/extensions/shogo-core` from a manifest-only skeleton into a real buildable VS Code extension shell.

## What Phase 3 adds

- Buildable TypeScript extension package.
- Shogo chat `WebviewViewProvider`.
- Chat webview HTML/CSS/JS shell with strict CSP nonce.
- Agent health client for the future local service.
- Context store for selected text and active file context.
- Command registration module.
- Static tree providers for Tasks, Checkpoints, Runtime, and Integrations.
- Web extension entry point.
- Local VS Code type shim for Phase 3 validation without adding monorepo dependencies.

## Extension commands

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

## Security posture

Phase 3 still does not execute shell commands, mutate files, call Git writes, install packages, deploy, or call paid model providers directly.

Workspace-trust-sensitive commands are guarded in the command layer:

- patch preview
- checkpoint create
- source-control review

Read-only chat shell and selected context collection are allowed in this phase, with context truncation.

## Agent bridge behavior

The extension reads `shogo.agentService.url`.

- Default `http://127.0.0.1:0` means no agent is configured yet.
- `/health` is used for health checks when a concrete URL is configured.
- `/chat` is used for chat requests when a concrete URL is configured.
- Without a configured agent, the webview returns a local Phase 3 placeholder response.

## Build and checks

```bash
bun run shogo-ide:extension:typecheck
bun run shogo-ide:extension:build
bun run shogo-ide:phase3:check
```

## What remains for Phase 4

- Real local Shogo agent service process.
- Service discovery/supervision from extension or desktop shell.
- Streaming chat/task events.
- Native diff previews backed by a patch engine.
- Checkpoint implementation.
- Runtime logs/routes/preview integration.
- VS Code Git API integration for source-control review.
