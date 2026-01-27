import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

// Prevent multiple instances during hot reload in development
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Create adapter for PostgreSQL connection
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export type { PrismaClient } from '../generated/prisma/client';
export * from '../generated/prisma/client';
