# Phase 4 Distribution Integration

Phase 4 makes the Shogo Code - OSS distribution path concrete without vendoring upstream Code - OSS source into this monorepo.

## What Phase 4 adds

- Materialized product metadata generation.
- Distribution manifest for the Shogo IDE build path.
- Default settings for telemetry, workspace trust, and Shogo command approval.
- Default layout recommendation that makes Shogo the primary activity container while keeping VS Code built-ins.
- Built-in extension descriptor for `shogo.shogo-core`.
- Shogo Core welcome content and getting-started walkthrough.
- Phase 4 validation script.

## Files

```text
apps/shogo-ide/distribution/distribution.manifest.json
apps/shogo-ide/distribution/defaults/settings.json
apps/shogo-ide/distribution/defaults/layout.json
apps/shogo-ide/distribution/builtin-extensions/shogo-core.json
apps/shogo-ide/distribution/generated/product.json
apps/shogo-ide/distribution/generated/distribution.generated.json
apps/shogo-ide/scripts/materialize-distribution.mjs
apps/shogo-ide/scripts/phase4-check.mjs
```

## Product posture

- Product name: `Shogo IDE`.
- Application name: `shogo-ide`.
- Protocol: `shogo-ide://`.
- Desktop data folder: `.shogo-ide`.
- Server data folder: `.shogo-ide-server`.
- Extension gallery: Open VSX.
- Telemetry: off by default.
- Workspace trust: enabled.

## Built-in extension posture

`shogo-core` is treated as a first-party bundled extension:

```text
publisher: shogo
name: shogo-core
id: shogo.shogo-core
source: apps/shogo-ide/extensions/shogo-core
```

It contributes:

- Shogo activity container.
- Chat webview.
- Agent Tasks tree.
- Checkpoints tree.
- Runtime tree.
- Integrations tree.
- Welcome content for Shogo views.
- `shogo.getStarted` walkthrough.
- Shogo command/configuration defaults.

## Why no Code - OSS source is vendored yet

No Code - OSS source is vendored in Phase 4. The distribution files are designed to be consumed by a local ignored checkout at:

```text
apps/shogo-ide/upstream/vscode/
```

This keeps the current repo lightweight while preserving a clear build contract. Once we decide submodule vs subtree vs separate fork, the generated `distribution/generated/product.json` can become the product metadata source copied into the Code - OSS checkout/package flow.

## Materialization

Run:

```bash
bun run shogo-ide:distribution:materialize
```

This generates:

```text
apps/shogo-ide/distribution/generated/product.json
apps/shogo-ide/distribution/generated/distribution.generated.json
```

## Validation

Run:

```bash
bun run shogo-ide:phase4:check
```

Recommended full chain:

```bash
bun run shogo-ide:phase1:check
bun run shogo-ide:phase2:check
bun run shogo-ide:phase3:check
bun run shogo-ide:distribution:materialize
bun run shogo-ide:phase4:check
bun run shogo-ide:extension:typecheck
bun run shogo-ide:extension:build
```

## Still not done in Phase 4

Phase 4 does not yet:

- clone Code - OSS,
- run Code - OSS build scripts,
- package signed desktop binaries,
- start a local Shogo agent service,
- replace the current Monaco IDE,
- publish extension marketplace entries,
- configure updater channels.

Those belong to the next production-hardening and package-build phase.
