# @shogo/state-api Reference

Schema-first reactive state management bridging ArkType to MST with isomorphic execution.

## Schematic Module

Core transformation pipeline: ArkType → Enhanced JSON Schema → MST.

### createStoreFromScope

```typescript
createStoreFromScope(
  scope: Scope<any> | Record<string, Scope<any>>,
  options?: MSTConversionOptions
): MSTConversionResult
```

Main entry point. Transforms an ArkType scope into MST models and store factory.

### arkTypeToEnhancedJsonSchema

```typescript
arkTypeToEnhancedJsonSchema(
  arkType: Type | Scope<any> | Record<string, Scope<any>>,
  nameOrOptions?: string | EnhancedJsonSchemaOptions,
  options?: EnhancedJsonSchemaOptions
): EnhancedJsonSchema
```

Converts ArkType definitions to Enhanced JSON Schema with `x-*` extensions.

### enhancedJsonSchemaToMST

```typescript
enhancedJsonSchemaToMST(
  schema: EnhancedJsonSchema,
  options?: MSTConversionOptions
): MSTConversionResult
```

Generates MST models from Enhanced JSON Schema.

### Types

```typescript
interface MSTConversionResult {
  models: Record<string, IAnyModelType>
  collectionModels: Record<string, IAnyModelType>
  RootStoreModel?: IAnyModelType
  createStore: (env?: any) => any
  domains?: Record<string, MSTConversionResult>
}

interface MSTConversionOptions {
  generateActions?: boolean
  validateReferences?: boolean
  arkTypeScope?: Scope<any>
  enhanceModels?: (model, name) => IAnyModelType
  enhanceCollections?: (collection, name) => IAnyModelType
  enhanceRootStore?: (rootStore) => IAnyModelType
}
```

---

## Meta-Store Module

Schema definitions as queryable entities.

### Bootstrap Functions

```typescript
getMetaStore(env?: IMetaStoreEnvironment): MetaStore
createMetaStoreInstance(env?: IMetaStoreEnvironment): MetaStore
resetMetaStore(): void
```

`getMetaStore()` returns singleton. `createMetaStoreInstance()` creates isolated instance for testing.

### Runtime Store Cache

```typescript
getRuntimeStore(schemaId: string, location?: string): any | undefined
cacheRuntimeStore(schemaId: string, store: any, location?: string): void
clearRuntimeStores(): void
getCachedSchemaIds(): string[]
removeRuntimeStore(schemaId: string, location?: string): boolean
```

Manages runtime stores keyed by schema ID and location.

### View Executor

```typescript
executeView(
  schemaName: string,
  viewName: string,
  params?: Record<string, any>
): Promise<any>
```

Executes a named view (query or template) on a schema.

---

## Environment Module

Dependency injection via MST environment.

### IEnvironment

```typescript
interface IEnvironment {
  services: {
    persistence: IPersistenceService
  }
  context: {
    schemaName: string
    location?: string
  }
}
```

Injected at store creation, accessed via `getEnv()` in models.

### IMetaStoreEnvironment

```typescript
interface IMetaStoreEnvironment {
  services?: {
    persistence?: IPersistenceService
  }
}
```

Simplified environment for meta-store.

---

## Persistence Module

Pluggable storage abstraction.

### IPersistenceService

```typescript
interface IPersistenceService {
  saveCollection(ctx: PersistenceContext, snapshot: any): Promise<void>
  loadCollection(ctx: PersistenceContext): Promise<any | null>
  saveEntity(ctx: EntityContext, snapshot: any): Promise<void>
  loadEntity(ctx: EntityContext): Promise<any | null>
  loadSchema?(name: string): Promise<any>
  listSchemas?(): Promise<any[]>
}

interface PersistenceContext {
  schemaName: string
  modelName: string
  location?: string
}

interface EntityContext extends PersistenceContext {
  entityId: string
}
```

### Implementations

| Class | Environment | Description |
|-------|-------------|-------------|
| `FileSystemPersistence` | Node.js | JSON files at `{location}/{schema}/data/{model}.json` |
| `NullPersistence` | Testing | In-memory, no disk I/O |

### Schema I/O

```typescript
saveSchema(schema: any, templates?: Record<string, string>, workspace?: string): Promise<string>
loadSchema(name: string, workspace?: string): Promise<{ metadata, enhanced }>
listSchemas(workspace?: string): Promise<Array<{ name, id, createdAt, path }>>
```

### Data I/O

```typescript
saveCollection(schemaName, modelName, snapshot, workspace?): Promise<void>
loadCollection(schemaName, modelName, workspace?): Promise<any>
loadCollections(schemaName, workspace?): Promise<Map<string, any>>
```

---

## Composition Module

MST mixins for cross-cutting concerns.

### CollectionPersistable

```typescript
const CollectionPersistable = types.model()
  .views(self => ({
    get persistenceContext(): PersistenceContext
  }))
  .actions(self => ({
    loadAll(): Promise<void>,
    loadById(id: string): Promise<void>,
    saveAll(): Promise<void>,
    saveOne(id: string): Promise<void>
  }))
```

Add to collections via `types.compose(MyCollection, CollectionPersistable)`.

---

## Core Module

Type helpers and utilities.

### MST Type Helpers

```typescript
type InstanceOfModel<M> = Instance<M>
type SnapshotInOfModel<M> = SnapshotIn<M>
type SnapshotOutOfModel<M> = SnapshotOut<M>
```

### ArkType Utilities

```typescript
validateWithArkType<T>(schema, data): ValidationResult<T>
validateField<T>(schema, fieldName, value): ValidationResult
createValidator<T>(schema): (data) => data is T
toJSONSchema(schema): object
```

### Environment Helpers

```typescript
getEnvironment<T>(model): T
getService<T>(model, serviceName): T
createEnvironment(context, services?, config?): BaseEnvironment
isClientEnvironment(env): boolean
isServerEnvironment(env): boolean
```

---

## Utils Module

### Template Rendering

```typescript
createTemplateEnvironment(config: TemplateConfig): nunjucks.Environment
renderTemplate(env, templateName, context): string

interface TemplateConfig {
  templatesPath: string
  autoescape?: boolean
}
```

### String Utilities

```typescript
camelCase(str: string): string  // First char lowercase
```

---

## See Also

- [Architecture](../ARCHITECTURE.md) — System design
- [Concepts](../CONCEPTS.md) — Key abstractions
- [Enhanced JSON Schema](ENHANCED_JSON_SCHEMA.md) — Schema format
