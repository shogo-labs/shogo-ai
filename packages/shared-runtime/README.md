# `@shogo/shared-runtime`

Shared utilities used by both `apps/api` and `packages/agent-runtime`.
Everything in this package is **AGPL-3.0** — it ships inside the cloud
pod, not into customer-distributed binaries.

## Cloud workspace sync

The agent-runtime pod has two complementary sync mechanisms. Which
one writes per-turn depends on `Project.cloudSyncMode` (see
[Cloud pod sync architecture](../../apps/docs/docs/architecture/cloud-pod-sync.md)
for the user-facing design doc).

### `S3Sync` (`src/s3-sync.ts`)

Two-layer tarball strategy with content-addressed deps caching. Public surface used by the runtime:

- `initializeS3Sync(localDir, { suppressProjectArchive? })` — download
  layered archives, restore deps in the background, optionally skip
  the Layer 2 uploader. Returns `{ sync, downloadSucceeded }` or
  `null` if S3 isn't configured.
- `S3Sync.triggerSync(immediate)` — fire-and-forget upload trigger.
- `S3Sync.flushAndShutdown(timeoutMs)` — number form, back-compat.
- `S3Sync.flushAndShutdown({ timeoutMs, forceProjectArchive })` — opts
  form. When `forceProjectArchive=true`, the cold-start tarball is
  uploaded even if Layer 2 is suppressed and even if there are no
  pending file changes (used by the runtime at evict in `git_only`).
- `S3Sync.setSuppressProjectArchive(boolean)` — runtime-mutable toggle
  for Layer 2 uploads. Wired to `GitWorkspaceSync.onDegrade` /
  `onRecovered` so the project-archive uploader engages automatically
  when git push starts failing and re-suppresses on recovery.
- `S3Sync.snapshotProjectArchiveFromGit()` — write a cold-start
  tarball by running `git archive HEAD` over the workspace. Used at
  evict in healthy `git_only` mode.

### `GitWorkspaceSync` (`src/git-sync.ts`)

Per-turn `git push` to the smart-HTTP backend at
`/api/projects/:id/git/*`. Mirrors `S3Sync`'s public shape so call
sites in `agent-runtime/server.ts` are uniform.

- `triggerSync(immediate)` — debounced (1.5 s) by default, immediate
  bypasses the debounce.
- `flushAndShutdown(timeoutMs)` — one last push attempt, returns
  within `timeoutMs` even if the push hangs.
- `isDegraded` / `consecutiveFailures` — read-only diagnostics.
- Config callbacks `onDegrade(reason)` and `onRecovered()` for the
  S3-fallback wiring. After `degradeAfterFailures` (default 3)
  consecutive push failures, `onDegrade` fires once. After the next
  successful push, `onRecovered` fires.

### Mode helper

`resolveCloudSyncMode(env?)` reads `SHOGO_CLOUD_SYNC_MODE` from the
environment (defaults to `s3`, clamps unknown values).

### License boundary

The worker has a similar `commitAndPush` helper at
`packages/shogo-worker/src/lib/git-cloner.ts`, but it's MIT (the
worker ships into customer environments). The git-sync code in
**this** package is duplicated rather than imported to keep that
licensing surface clean.

## Other modules

- `s3-sync.ts` — described above
- `git-sync.ts` — described above
- `postgres-backup.ts` — pg_dump-based backup/restore
- `lsp-service.ts` — TS language server lifecycle
- `diagnostics.ts` — tsc + eslint runner used by the chat tool
- `preview-token.ts` — preview deployments token verification
- `server-framework.ts` — shared OTEL/CORS/auth wiring used by both
  `apps/api` and `packages/agent-runtime`
- `instrumentation.ts` — OpenTelemetry bootstrap
- `ai-proxy.ts`, `ai-client.ts` — model proxy and client
- `runtime-types.ts` — pool/template enum
- `tech-stack-registry.ts` — supported tech stacks
- `platform-pkg.ts` — bun/pnpm/yarn shim
- `stream-buffer.ts` — durable stream resume

## Tests

```
bun run test
```

Uses `scripts/run-tests-isolated.ts` (one Bun process per file) to
avoid `mock.module` cross-file leakage. Don't `bun test` directly
unless you're running a single file.
