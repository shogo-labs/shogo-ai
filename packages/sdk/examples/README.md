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
"@shogo-ai/sdk": "^1.7.0"   // use the latest published version
```

Or run the repo's materialize helper against the copied manifest, which rewrites
every `@shogo-ai/*` `workspace:*` pin to the latest published `^X.Y.Z`:

```sh
bun run scripts/materialize-runtime-template.ts path/to/your-copy/package.json
```

Then `bun install` as usual.
