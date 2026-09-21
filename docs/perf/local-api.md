# Local API profile and workspace-runtime performance

Measurements are from `bun scripts/bench/api-import-cost.ts` on the development
macOS host used for this worktree. RSS is sampled after `/api/health` becomes
ready; it includes Bun/JIT/Prisma/native mappings but no spawned project
runtime.

* Baseline monolithic `server.ts`: 442.7 MiB API RSS.
* Earlier local-composer measurement: 388.0 MiB API RSS.
* Final local composer measurement: 292.4 MiB API RSS.

The local entrypoint imports four lifecycle/composer modules directly; the
route composition lives in `apps/api/src/app/create-local-app.ts` and mounts
44 local-safe route/service modules. Cloud-only route and service modules are
not evaluated by the local entrypoint.

The local desktop bundle guardrail is:

```text
bun run check:api-local-bundle
Local API bundle passed (5731 KiB)
```

The final verification measured a 5,731 KiB bundle and a single API process
with no descendants at the health checkpoint.

The check verifies that the local composer has no direct cloud route/Redis
imports and keeps the API bundle below 18 MiB. The local route-parity test
also covers the desktop profile, agent proxy, PTY terminal, preview,
diagnostics, thumbnails, heartbeat, workspace, and metadata endpoints.
RSS and lifecycle benchmarks should be rerun on Windows 8 GB and Intel macOS
before tightening the budget.
