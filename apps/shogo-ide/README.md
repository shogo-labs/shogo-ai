# Shogo IDE

This workspace contains the Shogo Code - OSS distribution assets used by the Desktop app.

## What lives here

- `product.shogo.template.json` — Shogo product identity and marketplace/telemetry posture.
- `distribution/` — generated product/default settings consumed by the local Code - OSS checkout.
- `extensions/shogo-core/` — bundled Shogo extension that owns the right-side chat webview and context commands.
- `hardening/` — packaging, security, and runtime-readiness metadata.
- `scripts/` — validation and materialization helpers.

The upstream Code - OSS source tree is intentionally not tracked. Local setup clones it into:

```text
apps/shogo-ide/upstream/vscode/
```

That directory is ignored by Git.

## Local setup

Print the clone command when you need to create the upstream checkout manually:

```bash
bun run --cwd apps/shogo-ide codeoss:clone:print
```

The Desktop launcher also performs the required local setup automatically when the Shogo IDE is opened.

## Validation

```bash
bun run --cwd apps/shogo-ide phase1:check
bun run --cwd apps/shogo-ide phase2:check
bun run --cwd apps/shogo-ide phase3:check
bun run --cwd apps/shogo-ide phase4:check
bun run --cwd apps/shogo-ide phase5:check
bun run --cwd apps/shogo-ide phase6:check
bun run --cwd apps/shogo-ide extension:typecheck
bun run --cwd apps/shogo-ide distribution:materialize
```

## Runtime behavior

Desktop opens Shogo IDE as a managed Code - OSS web workbench. Each Shogo app window and project workspace gets its own IDE window/profile, while Code - OSS source and runtime caches stay outside tracked source.
