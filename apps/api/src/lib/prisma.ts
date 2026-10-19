// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import type { PrismaClient } from '../generated/prisma-pg/client';
import { createPrismaClient } from './create-prisma-client';

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? await createPrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export { appDatabaseUrl } from './create-prisma-client';
export type { PrismaClient } from '../generated/prisma-pg/client';
export * from '../generated/prisma-pg/client';
