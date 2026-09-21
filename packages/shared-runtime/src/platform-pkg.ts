// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Re-export shim. The implementation now lives in `packages/cli/src/pkg.ts`
 * under MIT, lifted from this file in
 * https://github.com/shogo-labs/shogo-ai (commit lifting `platform-pkg.ts`
 * into the SDK to remove an AGPL runtime dependency from the published
 * `@shogo-ai/sdk` tarball).
 *
 * This shim exists so existing consumers (`agent-runtime`,
 * `apps/api`, etc.) that import from `@shogo/shared-runtime` keep working
 * without churn. New code should import directly from
 * `packages/cli/src/pkg.ts`.
 *
 * Note: SDK build artifacts (`packages/sdk/dist/cli/pkg.*`) must exist
 * for this re-export to resolve. `bun run build` in `packages/sdk` if
 * the dist is stale — `bun dev:all` does not rebuild the SDK on its own.
 */

export {
  PlatformPackageManager,
  pkg,
  isNodeAvailableOnWindows,
  isNodeAvailableOnUnix,
  resolveBinInvocation,
  _resetUnixNodeCache,
  NodeMissingError,
  type PkgInstallOptions,
  type PkgExecOptions,
} from '../../cli/src/pkg'
