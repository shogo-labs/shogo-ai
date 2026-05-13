<!-- SPDX-License-Identifier: MIT -->
<!-- Copyright (C) 2026 Shogo Technologies, Inc. -->

# @shogo-ai/cli

CLI helpers consumed by the `shogo` binary (still shipped via
`@shogo-ai/sdk`'s `bin` field). Most users won't import this package
directly; it exists so the deploy/manifest/packager logic can evolve
independently from the SDK release cadence.

| Subpath | Use |
| --- | --- |
| `@shogo-ai/cli/deploy` | `validateManifest`, `runDeploy`, manifest types. |
| `@shogo-ai/cli/pkg` | `pkg(...)` — package manager detection and dispatch (npm/bun/pnpm/yarn). |

## License

MIT — see [LICENSE](./LICENSE).
