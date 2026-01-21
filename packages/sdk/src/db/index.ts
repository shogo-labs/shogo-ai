/**
 * Shogo Database Module
 *
 * Pass-through to Prisma. The SDK accepts your Prisma client
 * and exposes it directly as `shogo.db`.
 *
 * @example
 * ```typescript
 * import { PrismaClient } from '@prisma/client'
 * import { createClient } from '@shogo/sdk'
 *
 * const prisma = new PrismaClient()
 * const shogo = createClient({ db: prisma })
 *
 * // shogo.db IS prisma - direct pass-through
 * await shogo.db.todo.findMany()
 * ```
 */

// No wrapper code - SDK users pass their Prisma client directly
// The client.ts file handles storing the reference
