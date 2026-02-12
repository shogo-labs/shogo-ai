/**
 * Shogo SDK Generators
 *
 * Generate server functions, domain stores, and types from Prisma schema.
 * Supports both web (Hono server) and Expo (HTTP API).
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

// Server generator (Hono)
export {
  generateServer,
  generateDbModule,
  type ServerGeneratorConfig,
} from './server-generator'

// Auth store generator
export {
  generateAuthStore,
  getUserModel,
  hasUserModel,
  type AuthStoreGeneratorOptions,
} from './auth-store-generator'

// Docs generator (Docusaurus)
export {
  generateDocs,
  generateModelDoc,
  generateModelsIndex,
  generateApiOverview,
  type GeneratedDocFile,
  type DocsGeneratorConfig,
} from './docs-generator'

// Docs site scaffolding (Docusaurus 3.9)
export {
  generateDocsSiteScaffold,
  generateDocsTsConfig,
  type DocsSiteConfig,
} from './docs-site-generator'

// Admin routes generator
export {
  generateAdminRoutes,
  type AdminRoutesGeneratorConfig,
  type GeneratedAdminRoutesFile,
} from './admin-routes-generator'

// Legacy exports (for backward compatibility)
export { generateServerFunctions } from './server-functions'
export { generateDomainStore } from './domain-store'
export { generateApiClient } from './api-client'
export { generateApiDomainStore } from './api-domain-store'
