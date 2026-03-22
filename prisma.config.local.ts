// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { defineConfig, env } from 'prisma/config'

export default defineConfig({
  schema: 'prisma/schema.local.prisma',
  datasource: {
    url: env('DATABASE_URL', 'file:./shogo.db'),
  },
})
