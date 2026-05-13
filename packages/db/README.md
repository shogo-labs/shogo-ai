<!-- SPDX-License-Identifier: MIT -->
<!-- Copyright (C) 2026 Shogo Technologies, Inc. -->

# @shogo-ai/db

Prisma adapter helpers — auto-detects PostgreSQL/SQLite/libSQL from
`DATABASE_URL` and wires up the right driver. The actual Prisma client
generation stays your project's concern; this package just gives you a
one-line `createPrismaClient(PrismaClient)` factory.

## Install

```bash
bun add @shogo-ai/db @prisma/client
# Plus the adapter you actually use:
bun add @prisma/adapter-pg          # for postgres://...
bun add @prisma/adapter-libsql      # for file://... or libsql://...
```

Adapters are optional peers — install only the ones you need.

## License

MIT — see [LICENSE](./LICENSE).
