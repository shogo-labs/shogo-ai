# Phase 6 Production Hardening

Phase 6 adds production hardening around the Shogo IDE path without vendoring Code - OSS source or shipping signed binaries yet.

## What Phase 6 adds

- Release channel policy for insiders, beta, and stable.
- Security policy for workspace trust, command approval, context redaction, webviews, marketplace, and telemetry.
- Packaging checklist for macOS, Windows, and Linux.
- Generated production-readiness report.
- Desktop launcher diagnostics and stricter readiness checks.
- Replacement gate rendering for all launch blockers.
- Phase 6 validation script.

## Files

```text
apps/shogo-ide/hardening/release-channels.json
apps/shogo-ide/hardening/security-policy.json
apps/shogo-ide/hardening/packaging-checklist.json
apps/shogo-ide/hardening/generated/production-readiness.json
apps/shogo-ide/scripts/generate-hardening-report.mjs
apps/shogo-ide/scripts/phase6-check.mjs
```

## Desktop launcher hardening

`apps/desktop/src/shogo-ide.ts` now reports:

- generated product metadata status,
- hardening report status,
- Code - OSS checkout status,
- executable discovery status,
- executable permission status,
- full diagnostics list,
- last launch diagnostic file.

Launch readiness now requires:

```text
product template exists
shogo-core manifest exists
generated product.json exists
production-readiness report exists
executable exists
executable is executable by current user
```

If launch fails or is blocked, the diagnostic is written to:

```text
apps/shogo-ide/hardening/runtime/diagnostics/last-launch.json
```

## Security posture

- Workspace trust required for writes, shell commands, Git writes, package installs, deployments, and integrations.
- Command approval defaults to required.
- Microsoft Marketplace remains disabled by default.
- Open VSX is the default gallery.
- Telemetry defaults to off.
- Crash reports are opt-in and must redact secrets/file contents/prompts/terminal output.
- Webviews require strict CSP and nonce scripts.

## Release posture

Defined channels:

- `insiders`
- `beta`
- `stable`

Stable requires rollback artifact availability and security checklist approval.

## Commands

```bash
bun run shogo-ide:hardening:report
bun run shogo-ide:phase6:check
```

Recommended full chain:

```bash
bun run shogo-ide:distribution:materialize
bun run shogo-ide:hardening:report
bun run shogo-ide:phase1:check
bun run shogo-ide:phase2:check
bun run shogo-ide:phase3:check
bun run shogo-ide:phase4:check
bun run shogo-ide:phase5:check
bun run shogo-ide:phase6:check
bun run shogo-ide:extension:typecheck
bun run shogo-ide:extension:build
npx tsc --noEmit -p apps/desktop/tsconfig.json
```

## Manual gates remain

Phase 6 does not claim the IDE is fully shipped. Manual gates remain:

- clone/build Code - OSS,
- package actual artifacts,
- macOS signing and notarization,
- Windows signing,
- Linux package smoke tests,
- Open VSX compatibility matrix,
- large-repo performance testing,
- rollback artifact test,
- updater channel wiring.

## No commit or push

Phase 6 changes are intended to remain in the working tree until the user explicitly asks to commit or push.
