// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { defineConfig } from 'prisma/config'

const isLocalMode = process.env.SHOGO_LOCAL_MODE === 'true'

// NOTE: we use `process.env.DATABASE_URL ?? fallback` rather than Prisma's
// `env(name)` helper because the v7 helper throws PrismaConfigEnvError at
// config-load time when the var is unset. That breaks every static command
// (`prisma validate`, `prisma format`, and the desktop drift check at
// `scripts/check-desktop-schema-drift.ts` which calls
// `prisma migrate diff --from-migrations --to-schema`), none of which
// actually open a DB connection. Commands that *do* connect will fail
// fast against this fallback with a clearer error site than a cryptic
// config-loader crash.
const DATABASE_URL_FALLBACK = 'postgres://unused:unused@localhost:5432/unused'

export default defineConfig({
  schema: isLocalMode ? 'prisma/schema.local.prisma' : 'prisma/schema.prisma',
  datasource: {
    // Prisma CLI commands (notably `migrate deploy`) MUST connect DIRECTLY,
    // never through a transaction-mode PgBouncer: `migrate deploy` takes a
    // session-scoped advisory lock and issues DDL, both of which are unsafe
    // when acquire/statements can land on different pooled backends. So prefer
    // DATABASE_DIRECT_URL (-> platform-pg-rw) here. The RUNTIME client is
    // unaffected — it uses the PrismaPg adapter on DATABASE_URL (the pooler)
    // in apps/api/src/lib/prisma.ts. Locally/desktop DATABASE_DIRECT_URL is
    // unset and this falls back to DATABASE_URL.
    url: process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL ?? DATABASE_URL_FALLBACK,
  },
})
