/**
 * Shogo SDK Generators
 *
 * Generate server functions, domain stores, and types from Prisma schema.
 * Supports both TanStack Start (server functions) and Expo (HTTP API).
 */

export { generateFromPrisma, type GenerateOptions, type GenerateResult } from './prisma-generator'
export { generateServerFunctions } from './server-functions'
export { generateDomainStore } from './domain-store'
export { generateTypes } from './types-generator'
export { generateApiClient } from './api-client'
export { generateApiDomainStore } from './api-domain-store'
