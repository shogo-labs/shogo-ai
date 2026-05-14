<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!-- Copyright (C) 2026 Shogo Technologies, Inc. -->

# `@shogo/shared-runtime`

Workspace-only AGPL package containing the runtime helpers that glue the
hosted Shogo platform together — S3 sync, Postgres backup, K8s
self-assignment, the runtime Hono application factory, and the cluster /
control-plane types that pin them to the hosted topology.

This package is **not published to npm** and is licensed under
`AGPL-3.0-or-later`.

## File-level license map

Most of the canonical, generic, dependency-light helpers that used to
live here have been **lifted into MIT-licensed packages** so external
consumers can use them without the AGPL constraint. The files below are
thin AGPL re-export shims so existing workspace AGPL consumers
(`@shogo/agent-runtime`, `@shogo/api`) continue to import from
`@shogo/shared-runtime` unchanged.

### MIT (re-export shims pointing to a published `@shogo-ai/*` package)

| File | Canonical MIT home |
| --- | --- |
| `src/chat-message.ts` | `@shogo-ai/core/chat-message` |
| `src/instrumentation.ts` | `@shogo-ai/core/instrumentation` |
| `src/logger.ts` | `@shogo-ai/core/logger` |
| `src/stream-buffer.ts` | `@shogo-ai/core/stream-buffer` |
| `src/macos-junk.ts` | `@shogo-ai/core/macos-junk` |
| `src/tech-stack-registry.ts` | `@shogo-ai/core/tech-stack-registry` |
| `src/platform-pkg.ts` | `@shogo-ai/cli/pkg` |
| `src/ai-client.ts` | `@shogo-ai/agent/ai-client` |
| `src/ai-proxy.ts` | `@shogo-ai/agent/ai-proxy` |

The shims themselves carry an `AGPL-3.0-or-later` SPDX header (since
they live inside an AGPL package) but compile to a one-line `export *`
that resolves to MIT code at runtime.

### Stay AGPL — hosted-platform glue

These files have hard cluster / control-plane / SaaS coupling and stay
AGPL inside this package. Do not move these to MIT without lifting the
hosted-only assumptions out first.

| File | Why AGPL |
| --- | --- |
| `src/s3-sync.ts` | `S3_WORKSPACES_BUCKET`, layered tar keys, Knative readiness model |
| `src/postgres-backup.ts` | `S3_WORKSPACES_BUCKET`, `postgres-backups/...` key layout |
| `src/self-assign.ts` | K8s SA token, `/api/internal/pod-config/...`, pool assignment marker |
| `src/token-refresh.ts` | Internal API + SA auth |
| `src/server-framework.ts` | `createRuntimeApp` with warm-pool routes, `WARM_POOL_MODE`, `RUNTIME_AUTH_SECRET`, internal preview-token validation |
| `src/runtime-types.ts` | Knative `componentLabel` / `containerName`, `RUNTIME_IMAGE`, K8s env array shape |
| `src/preview-token.ts` | Hosted preview-iframe auth |
| `src/diagnostics.ts` | `tsc` + `eslint` + build-buffer Hono router (still AGPL — kept here to avoid +20 Docker COPY lines and a new npm publish target) |
| `src/diagnostics-build-buffer.ts` | Per-project diagnostic ring buffer (paired with `diagnostics.ts`) |
| `src/lsp-service.ts` | `typescript-language-server` / `pyright` orchestration (still AGPL — same reason as above) |

## License

`AGPL-3.0-or-later` — see the repo-root `LICENSE`. The `MIT`
re-exports above link back to per-package `LICENSE` files in
`packages/<name>/LICENSE`.
