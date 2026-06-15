# Shogo IDE Phase 1 Spike

This workspace is the in-repo landing zone for the Shogo Desktop Code - OSS / VSCodium-style IDE distribution.

Phase 1 is intentionally isolated from the existing `apps/desktop` Electron app. The goal is to prove the Code - OSS distribution path without breaking the current Monaco-based IDE tab or desktop release flow.

## Phase 1 goals

- Keep the current Shogo Desktop app untouched while the spike matures.
- Define Shogo product identity for a Code - OSS distribution.
- Define bundled Shogo extension shape.
- Document all known edge cases before we clone/build Code - OSS.
- Provide a repeatable validation script for the spike files.
- Keep Code - OSS source out of this repo until we choose submodule, subtree, or separate fork workflow.

## Non-goals for Phase 1

- Do not replace the current IDE tab yet.
- Do not fork large VS Code source directly into this monorepo yet.
- Do not enable Microsoft Marketplace.
- Do not modify extension host internals.
- Do not ship this as production desktop.

## Suggested local Code - OSS checkout

Print the exact clone command:

```bash
bun run --cwd apps/shogo-ide codeoss:clone:print
```

Recommended local checkout path:

```text
apps/shogo-ide/upstream/vscode/
```

That path is ignored by Git so Phase 1 does not accidentally vendor a massive upstream tree.

## Validation

```bash
bun run --cwd apps/shogo-ide phase1:check
```

From the repo root you can also run:

```bash
bun run shogo-ide:phase1:check
```

## Target Phase 1 exit criteria

A Phase 1 spike is ready to advance when:

1. Code - OSS can be cloned locally outside tracked source.
2. `product.shogo.template.json` covers Shogo identity, protocol, data folder, telemetry posture, and Open VSX configuration.
3. The bundled `shogo-core` extension manifest declares the Shogo activity container, core views, commands, workspace trust, and virtual workspace behavior.
4. The edge-case checklist is reviewed.
5. The validation script passes.
6. No current `apps/desktop` runtime behavior changes.

## Intended integration after Phase 1

The current desktop app can later expose a launch/open action for the new IDE while the current IDE tab remains available as fallback:

```text
apps/desktop                existing Shogo shell
apps/shogo-ide              Code - OSS distribution spike
apps/shogo-ide/extensions   bundled Shogo extension(s)
```
