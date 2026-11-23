# Shogo SDK Examples

Each subdirectory is a standalone example app built on `@shogo-ai/sdk`.

## SDK dependency: `workspace:*`

These examples pin the SDK as:

```json
"@shogo-ai/sdk": "workspace:*"
```

Inside this monorepo that resolves to the local `packages/sdk` source (the
examples are members of the root `workspaces`), so changes you make to the SDK
are picked up immediately — no rebuild/republish needed while developing.

## Copying an example out of the monorepo

`workspace:*` only resolves from the monorepo root. If you copy an example into
a standalone project, replace the pin with a concrete published version before
installing, e.g.:

```jsonc
// package.json
"@shogo-ai/sdk": "2.6.1",   // the version you mean — check the latest on npm
```

Pin the exact version rather than a range: a range is re-resolved against npm on
every install, so a bad release can reach an app that never asked for it (that
is how 2.6.1 reached apps whose image only said `^2.6.0`).

Or run the repo's materialize helper against the copied manifest, which rewrites
every `@shogo-ai/*` `workspace:*` pin to the latest published `X.Y.Z`
(exact, never a range):

```sh
bun run scripts/materialize-runtime-template.ts path/to/your-copy/package.json
```

Then `bun install` as usual.
