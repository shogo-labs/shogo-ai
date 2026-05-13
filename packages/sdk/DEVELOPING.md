<!-- SPDX-License-Identifier: MIT -->
<!-- Copyright (C) 2026 Shogo Technologies, Inc. -->

# Developing `@shogo-ai/sdk`

Internal contributor guide. Not shipped to npm (`files` in `package.json`
only lists `dist/**` and `bin/cli.mjs`).

## TL;DR — the dev loop

Editing files under `packages/sdk/src/` hot-reloads through `apps/api`
and the mobile app **without** running `bun run build` or `tsup --watch`
in the SDK. The `bun dev:all` script is sufficient.

You only need to rebuild the SDK (`bun run build:sdk` from the monorepo
root, or `bun run build` from `packages/sdk/`) in three cases:

1. **Before publishing** — the npm tarball is the dist build.
   `publish-sdk.yml` does this for you on tag.
2. **Before running anything that consumes the SDK from `dist/`** —
   today the only place is the SDK's own `playgrounds/` and
   `examples/_template/` (they install the SDK via the symlinked
   `node_modules/@shogo-ai/sdk` and don't opt into the `development`
   condition).
3. **After changing tsup configuration or adding a new subpath
   export** — to verify the new entry actually emits.

Day-to-day, the loop is: edit `packages/sdk/src/...` → `apps/api`
restarts in <1s through `watch-api.ts` → mobile fast-refreshes via
Metro's `unstable_conditionNames` opt-in.

## Why this works (mechanism)

Three layers cooperate; each is independently optional, so any one
breaking degrades to the previous behavior (always-rebuild) rather
than crashing.

### 1. `tsconfig.base.json` `paths` — covers Bun, `tsc`, and any
   workspace that extends it.

The monorepo root `tsconfig.base.json` declares:

```json
"paths": {
  "@shogo-ai/sdk": ["packages/sdk/src/index.ts"],
  "@shogo-ai/sdk/agent": ["packages/sdk/src/agent/index.ts"],
  // ...22 entries total, one per subpath export
}
```

Bun's TS-aware module resolver reads tsconfig `paths` automatically,
so any `bun run`/`bun test` from a workspace that extends this base
(`apps/api`, `packages/ui-kit`) gets SDK source resolution for free.
`tsc --noEmit` does the same.

The file also has `baseUrl: "."`, so paths resolve relative to the
monorepo root regardless of which sub-package is the entry point.

### 2. `"development"` export condition — covers Metro and any
   future opt-in bundler.

`packages/sdk/package.json` declares each subpath as:

```json
"./agent": {
  "types": "./dist/agent/index.d.ts",
  "development": "./src/agent/index.ts",
  "import":  "./dist/agent/index.js",
  "require": "./dist/agent/index.cjs"
}
```

Tooling that opts into the `development` condition resolves to the
TS source; everything else falls through to `import`/`require`
(the `dist/` build), exactly as today. `types` stays first so
TypeScript's resolver consistently picks the dist `.d.ts`.

`apps/mobile/metro.config.js` opts in via:

```js
const enableSdkSourceHmr = process.env.NODE_ENV !== 'production'
if (enableSdkSourceHmr) {
  config.resolver.unstable_conditionNames = [...existing, 'development']
  config.resolver.sourceExts = [...existing, 'ts', 'tsx']
}
```

The `NODE_ENV !== 'production'` gate is critical: Expo prod export
and EAS Build set `NODE_ENV=production`, where the published-style
`dist/` resolution should always win. Local dev, simulator runs,
and EAS dev builds run with `NODE_ENV=development` and benefit.

### 3. Publish-side strip — keeps the npm tarball lean.

`.github/workflows/publish-sdk.yml`'s `Prepare package.json for
publish` step deletes every `development` key from `exports` before
`npm publish`. This matters because Vite serve mode auto-activates
the `development` condition; if a downstream Vite consumer received
`@shogo-ai/sdk` with a `development → ./src/agent/index.ts` entry
but the tarball didn't include `src/`, dev-mode resolution would
ENOENT. Stripping on publish makes the published shape identical
to pre-HMR — external consumers see only `import`/`require` →
`dist/`.

The script also still strips `workspace:*` deps (long-standing).
You can preview the post-strip `package.json` locally via:

```bash
cd packages/sdk
node -e "$(rg -A 30 'Stripped \\\$\\{strippedDevConditions' \
  ../../.github/workflows/publish-sdk.yml \
  | sed -n '/node -e .\$/,/^.*[\$]/p')"
```

…or just inspect a freshly built tarball: `npm pack` the SDK after
running the strip step manually.

## What's NOT covered (and why that's fine)

- `packages/sdk/examples/*` — these are scaffolded apps that
  consume the SDK as a published npm package via the symlinked
  `node_modules/@shogo-ai/sdk`. Editing example code hot-reloads
  via Vite as usual; editing SDK source while in an example app
  requires `bun run build:sdk`. This matches what an external
  user developing against `@shogo-ai/sdk` would experience and
  is intentionally consistent.

- `packages/sdk/bin/shogo.ts` — direct relative imports
  (`'../src/cli/pkg'`), so it always reads source and never
  needed the lift in the first place.

- `packages/{shared-runtime,agent-runtime,shared-app,...}` —
  these are AGPL workspace packages with their own standalone
  tsconfigs (no `extends` of `tsconfig.base.json`). They consume
  the SDK through `node_modules/@shogo-ai/sdk` →
  `packages/sdk/dist/` per the workspace symlink. To pick up
  SDK source changes from these packages you currently need
  `bun run build:sdk`; once SDK Wave 2+ lifts more code into
  the SDK and the back-shims become hot paths, we can opt
  these into the `development` condition too (single-line change
  per package's tsconfig or bunfig).

## Sanity check — am I actually getting source resolution?

From any workspace that extends `tsconfig.base.json`:

```bash
cd apps/api
bun -e 'console.log(Bun.resolveSync("@shogo-ai/sdk/agent", __dirname))'
# Expected:
# /Users/.../packages/sdk/src/agent/index.ts
```

If it prints a path under `packages/sdk/dist/`, something is
wrong with the path resolution (probably `tsconfig.base.json`
got reverted, or the workspace doesn't actually extend it).

For mobile, set `NODE_ENV` and grep Metro's resolver:

```bash
cd apps/mobile
node -e 'console.log(JSON.stringify(require("./metro.config.js").resolver.unstable_conditionNames))'
# Expected (with NODE_ENV unset / != production):
# [..., "development"]
```

## Adding a new subpath export

Five files to keep in sync:

1. `packages/sdk/tsup.config.ts` — add the `src/foo/index.ts` entry.
2. `packages/sdk/package.json` — add the four-key block under
   `exports["./foo"]` (`types` / `development` / `import` /
   `require`).
3. `tsconfig.base.json` — add a `paths["@shogo-ai/sdk/foo"]` entry.
4. (Optional) `packages/sdk/README.md` — document the new export.
5. `packages/sdk/scripts/verify-license-isolation.mjs` — no change
   needed; it auto-walks `src/`.

A future improvement is to drive (1)–(3) from a single source of
truth (probably a `subpaths.json` in the SDK).

### Worked example — Wave 1 lifts (May 2026)

The Wave 1 lifts (`logger`, `instrumentation`, `stream-buffer`,
`chat-message`, `model-catalog`) followed the canonical "lift from an
AGPL workspace package" pattern. Each lift is six edits:

1. **Copy** the source file from the AGPL package to
   `packages/sdk/src/<subpath>(/index).ts`. Replace the SPDX header
   with `MIT` and add a docblock noting where it was lifted from.
2. **Add** the file to `packages/sdk/tsup.config.ts` `entry`. If the
   module imports peer-dep packages that aren't already listed (e.g.
   `@opentelemetry/*`), add them to the `external` array too.
3. **Add** an `exports["./<subpath>"]` block in
   `packages/sdk/package.json` with `types` / `development` /
   `import` / `require`. If the module needs runtime peer packages
   for typecheck (Bun monorepo doesn't hoist by default), also add
   them to both `peerDependencies` (with `peerDependenciesMeta:
   optional: true`) and `devDependencies` so the SDK's local
   typecheck has them available.
4. **Add** a `paths["@shogo-ai/sdk/<subpath>"]` entry in
   `tsconfig.base.json`.
5. **Replace** the original AGPL source file with a thin re-export
   shim from `@shogo-ai/sdk/<subpath>`. Keep the AGPL SPDX header on
   the shim — re-exporting from MIT is fine, the shim itself remains
   AGPL because it lives inside an AGPL package.
6. **Add** `@shogo-ai/sdk: workspace:*` to the AGPL package's
   `dependencies` if it isn't already a dep, then `bun install` from
   the monorepo root to symlink it in.

Then `bun run build` from `packages/sdk/`, `bun run typecheck`,
`bun test src/`, `bun run verify:license-isolation`, and finally
spot-check the resulting tarball with `bun pm pack --dry-run`.

Two recurring gotchas from Wave 1, both surfaced by the SDK's
stricter DTS pass even though the original AGPL source typechecked
clean:

- **Implicit-`any` callback parameters** (e.g.
  `tracer.startActiveSpan(name, opts, async (span) => …)`) — annotate
  explicitly: `async (span: Span) => …`.
- **`'unref' in handle` narrowing** on `setInterval` return types
  doesn't survive the SDK's tsconfig (no `@types/node` or
  `@types/bun` in scope by default). Cast to a structural type and
  detect at runtime: `(handle as { unref?: () => void }).unref?.()`.

Both fixes are local to the lifted file, don't change behaviour, and
keep the file dependency-free of `@types/*`.

For lifting an entire **separate package** (e.g. `@shogo/model-catalog`),
the pattern is the same but step (5) replaces the package's
`src/index.ts` with a single `export * from '@shogo-ai/sdk/<subpath>'`
shim and **deletes** the now-redundant internal source files
(`models.ts`, `aliases.ts`, `helpers.ts`, …). This breaks any code
that was reaching into the internal files via relative path —
search the monorepo for `packages/<pkg>/src/<filename>` after the
delete and switch those imports to the public surface
(`@shogo/<pkg>` or `@shogo-ai/sdk/<subpath>`). Generated/scaffolded
code is the most likely place this hides.
