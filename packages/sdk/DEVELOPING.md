<!-- SPDX-License-Identifier: MIT -->
<!-- Copyright (C) 2026 Shogo Technologies, Inc. -->

# Developing the `@shogo-ai/*` packages

Internal contributor guide for the seven MIT packages under
`packages/{sdk,core,agent,db,email,voice,cli}/`. None of these dev
files ship to npm (`files` in each `package.json` lists only `dist/**`
and the SDK's `bin/cli.mjs`).

## Per-package layout

| Package | What's inside | Key peers |
| --- | --- | --- |
| `@shogo-ai/sdk` | Client surface — `createShogoClient`, React hooks, tools/memory/generators. Owns the published `shogo` binary. | `react`, `mobx`, `ai`, `@ai-sdk/react` (all optional) |
| `@shogo-ai/core` | License-isolated primitives shared across packages: `logger`, `instrumentation` (OTEL), `stream-buffer`, `chat-message`. | `@opentelemetry/*` (optional) |
| `@shogo-ai/agent` | Agent runtime: `agent-loop`, `pi-adapter`, `model-catalog`, `model-router`, `tool-orchestration`, `loop-detector`, `microcompact`, `prefix-fingerprint`, `hooks` (incl. bundled defaults). | `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core` (optional) |
| `@shogo-ai/db` | Prisma adapter helpers — auto-detects PG/SQLite/libSQL from `DATABASE_URL`. | `@prisma/adapter-pg`, `@prisma/adapter-libsql` (optional) |
| `@shogo-ai/email` | Multi-provider transactional email (SES, SMTP, OCI) + templates. | `nodemailer`, `@aws-sdk/client-ses` (optional) |
| `@shogo-ai/voice` | ElevenLabs/Twilio voice infra + React/RN UI primitives + visualizers. | `@elevenlabs/react`, `@elevenlabs/react-native`, `react`, `react-native`, `three`, `expo-gl`, `expo-three`, `@ai-sdk/react`, `ai` (all optional) |
| `@shogo-ai/cli` | `validateManifest` / `runDeploy` / `pkg` helpers consumed by the published `shogo` bin. | none |

`@shogo-ai/sdk` re-exports every moved subpath via deprecated shims so
existing `@shogo-ai/sdk/<subpath>` imports keep working through v1.x.
See `MIGRATION.md` for the full subpath → package map.

### Which package do I want?

```
Need a TypeScript client for a Shogo agent?
  → @shogo-ai/sdk

Building a backend / gateway / hosted runtime?
  Need an agent loop on top of pi-ai?           → @shogo-ai/agent
  Need just logging / OTEL / streaming helpers? → @shogo-ai/core
  Need Prisma client wiring?                    → @shogo-ai/db
  Need transactional email?                     → @shogo-ai/email

Building voice UX (web or React Native)?
  → @shogo-ai/voice

Writing a deploy script / CI integration?
  → @shogo-ai/cli
```

## TL;DR — the dev loop

Editing files under `packages/{sdk,core,agent,db,email,voice,cli}/src/`
hot-reloads through `apps/api` and the mobile app **without** running
`bun run build` or `tsup --watch` in any of these packages. The
`bun dev:all` script is sufficient.

You only need to rebuild a package (`bun run build` from
`packages/<pkg>/`) in three cases:

1. **Before publishing** — the npm tarball is the dist build.
   `publish-sdk.yml` does this for you on tag.
2. **Before running anything that consumes the package from `dist/`** —
   today the only place is the SDK's own `playgrounds/` and
   `examples/_template/` (they install the SDK via the symlinked
   `node_modules/@shogo-ai/sdk` and don't opt into the `development`
   condition).
3. **After changing tsup configuration or adding a new subpath
   export** — to verify the new entry actually emits.

Day-to-day, the loop is: edit `packages/<pkg>/src/...` → `apps/api`
restarts in <1s through `watch-api.ts` → mobile fast-refreshes via
Metro's `unstable_conditionNames` opt-in.

## Why this works (mechanism)

Three layers cooperate; each is independently optional, so any one
breaking degrades to the previous behavior (always-rebuild) rather
than crashing.

### 1. `tsconfig.base.json` `paths` — covers Bun, `tsc`, and any
   workspace that extends it.

The monorepo root `tsconfig.base.json` declares one entry per subpath
across all seven MIT packages:

```json
"paths": {
  "@shogo-ai/sdk": ["packages/sdk/src/index.ts"],
  "@shogo-ai/sdk/agent": ["packages/sdk/src/agent/index.ts"],
  "@shogo-ai/core/logger": ["packages/core/src/logger.ts"],
  "@shogo-ai/agent/agent-loop": ["packages/agent/src/agent-loop.ts"],
  "@shogo-ai/db": ["packages/db/src/index.ts"],
  "@shogo-ai/voice/react": ["packages/voice/src/react/index.ts"],
  // ...one entry per subpath export across all packages
}
```

Bun's TS-aware module resolver reads tsconfig `paths` automatically,
so any `bun run`/`bun test` from a workspace that extends this base
(`apps/api`, `packages/ui-kit`) gets source resolution for free across
all of `@shogo-ai/{sdk,core,agent,db,email,voice,cli}`. `tsc --noEmit`
does the same.

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

Metro also rewrites TypeScript-style `'./foo.js'` imports back to
`./foo.ts` for any origin under `packages/<pkg>/src/` where `<pkg>`
is one of the seven MIT packages — the list is `SHOGO_SOURCE_PACKAGES`
near the top of `metro.config.js`. When you add a new MIT package
(say `@shogo-ai/cache` later), append its directory name there too.

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

## Adding a new subpath export to an existing package

Four files to keep in sync (replace `<pkg>` with the package and
`<sub>` with the new subpath):

1. `packages/<pkg>/tsup.config.ts` — add the `src/<sub>/index.ts` entry.
2. `packages/<pkg>/package.json` — add the four-key block under
   `exports["./<sub>"]` (`types` / `development` / `import` /
   `require`).
3. `tsconfig.base.json` — add a `paths["@shogo-ai/<pkg>/<sub>"]` entry.
4. (Optional) `packages/<pkg>/README.md` — document the new export.

The license-isolation verifier auto-walks each MIT package's `src/`,
so it picks up the new file without changes.

## Adding a new MIT package

Six files plus boilerplate:

1. Create `packages/<pkg>/{package.json,tsconfig.json,tsup.config.ts,README.md}`
   (copy from a sibling like `packages/core/` and rename).
2. Add path entries for every subpath to `tsconfig.base.json` under
   the `paths` block.
3. Append `'<pkg>'` to `SHOGO_SOURCE_PACKAGES` in
   `apps/mobile/metro.config.js`.
4. Append a new entry to `MIT_PACKAGES` in
   `packages/sdk/scripts/verify-license-isolation.mjs`.
5. Add the publish job to `.github/workflows/publish-sdk.yml`'s
   matrix (or whatever publishing strategy you adopt).
6. If `@shogo-ai/sdk` should re-export the new package as a
   deprecated shim, add the shim file to `packages/sdk/src/<sub>/`
   and the matching entries in `packages/sdk/{package.json,tsup.config.ts}`.

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

### Worked example — Wave 2 lifts (May 2026)

Wave 2 lifted the agent runtime core: `loop-detector`, `microcompact`,
`prefix-fingerprint`, `tool-orchestration`, `hooks/*`, `model-router`,
`pi-adapter`, `agent-loop`. The pattern is identical to Wave 1 except
for two new gotchas surfaced by the larger surface area:

- **Cross-subpath imports inside the SDK must be relative, not aliased.**
  If `pi-adapter.ts` needs `getMaxOutputTokens` from `model-catalog`,
  write `import { getMaxOutputTokens } from './model-catalog'` —
  **not** `from '@shogo-ai/sdk/model-catalog'`. The aliased form fails
  at SDK bundle time because the alias resolves to `dist/`, which
  doesn't exist yet during the build that's producing it. Reserve the
  `@shogo-ai/sdk/<subpath>` form for downstream consumers (apps/api,
  packages/agent-runtime back-shims, etc.) — inside `packages/sdk/src/`
  always go relative.

- **JSON imports** (`import x from './foo.json'`) are picked up by
  tsup automatically and emitted as a separate chunk. No tsup config
  change is needed; just make sure the `.json` file lives next to the
  consuming `.ts` (so the relative path survives both source-resolution
  and dist-resolution). `model-router/routing-thresholds.json` is the
  canonical example.

- **Optional pi-* peer deps.** `pi-adapter`, `agent-loop`, `microcompact`,
  and `prefix-fingerprint` import from `@mariozechner/pi-agent-core` and
  `@mariozechner/pi-ai`. These go in `peerDependencies` (with
  `optional: true` in `peerDependenciesMeta`) **and** `devDependencies`
  in `packages/sdk/package.json`, plus the `external` array of
  `tsup.config.ts`. Apps that don't run the agent loop (e.g. a pure
  email-only consumer) can omit them entirely; bundlers see the peer as
  optional and don't error.

### Bundled hooks (the `loadAllHooks` story)

`loadAllHooks` lives in `@shogo-ai/agent` and ships with two bundled
defaults — `command-logger` and `session-memory` — that any agent
consumer gets for free:

- `command-logger` appends slash-command events to
  `<workspaceDir>/logs/commands.log` as JSONL.
- `session-memory` snapshots the last 10 messages to
  `<workspaceDir>/memory/<date>-session-<time>.md` when the user
  issues `/new`.

Each bundled hook is a directory under
`packages/agent/src/hooks/bundled/<name>/` containing `HOOK.md`
(frontmatter metadata) and `handler.ts` (implementation). Three
pieces of the agent package's build pipeline cooperate so this works
from both `src/` (development) and `dist/` (production):

1. `packages/agent/tsup.config.ts` lists each `handler.ts` as a build
   entry. The relative path is preserved, so output lands at
   `dist/hooks/bundled/<name>/handler.{js,cjs}`.
2. The same `tsup.config.ts`'s `onSuccess` hook copies each `HOOK.md`
   from `src/hooks/bundled/<name>/` to `dist/hooks/bundled/<name>/`.
3. `packages/agent/package.json#files` includes
   `dist/hooks/bundled/**/HOOK.md` so the `.md` files end up in the
   published `@shogo-ai/agent` tarball.

The registry's `loadHandlerFromDir` tries `.mjs`, `.js`, `.cjs`, then
`.ts` in that order — so dist consumers (Node) hit the compiled JS
and source consumers (Bun via tsconfig paths or the `development`
export condition) hit the original `.ts`. Adding a new bundled hook
is three steps:

1. `mkdir packages/agent/src/hooks/bundled/<your-hook>` and add
   `HOOK.md` + `handler.ts`.
2. Add `'src/hooks/bundled/<your-hook>/handler.ts'` to
   `packages/agent/tsup.config.ts` `entry`.
3. Extend the same `tsup.config.ts`'s `onSuccess` to copy
   `src/hooks/bundled/<your-hook>/HOOK.md` to
   `dist/hooks/bundled/<your-hook>/HOOK.md`.

`loadAllHooks` resolves `bundled/` via `import.meta.dir` and accepts
a `workspaceDir`; workspace-level hooks (`<workspaceDir>/hooks/`)
override bundled defaults by name when both register. The
`import.meta.dir` access is gated behind a structural cast (Bun
extension; falls back to `import.meta.url` on Node) so the package
can typecheck without `@types/bun`.
