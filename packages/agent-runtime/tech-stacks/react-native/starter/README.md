# React Native (bare) + Shogo backend

This is a bare **React Native** workspace (no Expo) with a colocated
**Hono + Prisma** API server at the root.

## Layout

- `App.tsx`, `index.js`, `app.json`, `babel.config.js`, `metro.config.js`
  — the React Native client.
- `prisma/schema.prisma`, `shogo.config.json`, `custom-routes.ts`,
  `scripts/generate.ts` — the API server scaffolding. `server.tsx` is
  generated on first boot by `bun x shogo generate`.

## Running

The Shogo runtime supervises both the Metro bundler and the API server.
You don't need to run anything manually — opening the workspace starts:

1. `bun install`
2. `bun x prisma generate` + `db push`
3. The Hono API server (`bun run server.tsx`) on port 3001
4. Metro for the mobile client

## Editing the data model

Append models to `prisma/schema.prisma`. The runtime will regenerate
`server.tsx`, the per-model CRUD routes under `src/generated/`, and the
typed client functions automatically.

For non-CRUD logic (aggregations, webhooks, external proxies), edit
`custom-routes.ts` — it mounts under `/api/`.
