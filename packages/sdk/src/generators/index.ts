/**
 * Shogo SDK Generators
 *
 * Generate code from Prisma schema:
 * - Hono routes (per-model)
 * - TypeScript types (per-model)
 * - OptimisticStore instances (per-model)
 * - MST models and collections (per-model)
 */

// Main generator
export {
  generateFromPrisma,
  parsePrismaSchema,
  type GenerateOptions,
  type GenerateResult,
  type GeneratedFile,
  type OutputConfig,
  type PrismaModel,
  type PrismaField,
  type PrismaDMMF,
  toCamelCase,
  toKebabCase,
  getIdField,
  getScalarFields,
  getRelationFields,
} from './prisma-generator'

// Routes generator
export {
  generateRoutes,
  generateRoutesIndex,
  generateModelRoutes,
  generateModelHooks,
  type GeneratedRouteFile,
  type GeneratedHooksFile,
  type RouteGeneratorConfig,
} from './routes-generator'

// Types generator
export {
  generateTypes,
  generateTypesPerModel,
  generateTypesIndex,
  generateModelTypes,
  type GeneratedTypeFile,
} from './types-generator'

// Stores generator (plain MobX)
export {
  generateStores,
  generateStoresIndex,
  generateModelStore,
  type GeneratedStoreFile,
  type StoreGeneratorConfig,
} from './stores-generator'

// MST Model generator
export {
  generateMSTModels,
  generateMSTModel,
  type GeneratedMSTModelFile,
} from './mst-model-generator'

// MST Collection generator
export {
  generateMSTCollections,
  generateMSTCollection,
  type GeneratedMSTCollectionFile,
} from './mst-collection-generator'

// MST Domain generator
export {
  generateMSTDomain,
  type GeneratedMSTDomainFile,
} from './mst-domain-generator'

// Legacy exports (for backward compatibility)
export { generateServerFunctions } from './server-functions'
export { generateDomainStore } from './domain-store'
