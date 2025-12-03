# Core Concepts

This document defines shared vocabulary for both skill users (app builders) and system extenders (developers). Understanding these concepts helps you navigate the documentation and communicate effectively about the system.

## Universal Concepts

### Intent → Schema → Runtime

Shogo AI follows a three-stage flow:

1. **Intent** — What you want to build, captured as structured entities during Discovery
2. **Schema** — The contract describing your domain (Enhanced JSON Schema format)
3. **Runtime** — Live, reactive state (MobX-State-Tree stores)

This embodies the principle of **"Runtime as Projection over Intent"**: the running system is always traceable back to what you originally asked for. Nothing is generated that wasn't derived from captured requirements.

### The 5-Phase Pipeline

Building an application progresses through five phases, each with a dedicated AI skill:

```
Discovery → Schema Design → Implementation Spec → Code Generation → Documentation
```

- **Discovery** — Capture problem, analyze artifacts, derive requirements
- **Schema Design** — Generate domain schema from requirements
- **Implementation Spec** — Define modules, interfaces, and tests
- **Code Generation** — Produce TDD-ready scaffolding
- **Documentation** — Generate architecture guides and API docs

Each phase captures structured entities in Wavesmith. The output of each phase feeds into the next, maintaining full traceability.

### Schemas as Living Entities

Schemas in Shogo AI are not build artifacts that get discarded after code generation. They remain:

- **Queryable at runtime** — The meta-store tracks all schemas and their structure
- **Isomorphic** — The same schema drives behavior on server (Node.js) and browser (Sandpack)
- **Self-describing** — Each schema contains Schema → Model → Property hierarchy

This enables runtime introspection, dynamic UI generation, and consistent behavior across environments.

---

## For Skill Users

These concepts help you understand what each pipeline phase produces and how they connect.

### Discovery Phase Entities

| Entity | Purpose |
|--------|---------|
| **DiscoverySession** | Root entity tracking the entire discovery process |
| **ProblemStatement** | Your problem description, pain points, desired outcome |
| **Artifact** | Uploaded files or examples with domain-adaptive tags |
| **Analysis** | Findings from analyzing artifacts (complexity rated low/medium/high) |
| **Requirement** | Derived requirement with acceptance criteria |
| **SolutionProposal** | Implementation phases with specific deliverables |

The flow: Problem → Artifacts → Analysis → Requirements → Solution proposal.

### Schema Design Phase

The schema designer transforms requirements into a domain model:

- **Domain entities** — Named types with typed properties (User, Project, Task)
- **Relationships** — One-to-many, many-to-many connections between entities
- **Enhanced JSON Schema** — Standard JSON Schema with MST-specific extensions
- **Coverage reports** — Links each requirement to schema elements that satisfy it

### Implementation Spec Entities

| Entity | Purpose |
|--------|---------|
| **ModuleSpecification** | Black-box functional unit (categorized as input/process/output) |
| **InterfaceContract** | Function signature with inputs, outputs, errors, and algorithm strategy |
| **TestSpecification** | Test scenario in Given/When/Then format, linked to requirements |

The spec phase establishes **cross-layer traceability**:

```
Requirement → Module → Interface → Test
```

Every test traces back to a requirement. Every interface belongs to a module that implements specific requirements.

### Code Generation Outputs

The code generator produces TDD-ready scaffolding:

- **Function stubs** — `NotImplementedError` bodies only (no executable logic)
- **Pydantic models** — Generated from schema entities
- **pytest scaffolding** — Tests in Given/When/Then format
- **TDD workflow** — All tests fail initially; you implement to make them pass

---

## For System Extenders

These concepts explain how the system works internally.

### Transformation Pipeline

Schemas flow through a three-stage transformation:

```
ArkType Scope
    ↓ arkTypeToEnhancedJsonSchema()
Enhanced JSON Schema
    ↓ enhancedJsonSchemaToMST()
MST Models + Collections
    ↓ createStore(environment)
Runtime Store
```

Each stage produces artifacts the next stage consumes. See [Architecture](ARCHITECTURE.md) for detailed diagrams.

### Enhanced JSON Schema Extensions

Standard JSON Schema 2020-12 with `x-*` extensions for MST generation:

| Extension | Values | Purpose |
|-----------|--------|---------|
| `x-mst-type` | `identifier`, `reference`, `maybe-reference` | MST type mapping |
| `x-reference-type` | `single`, `array` | Reference cardinality |
| `x-computed` | `true` | Marks inverse relationship arrays (auto-calculated) |
| `x-original-name` | string | Preserves model name through transformation |

See [Enhanced JSON Schema Reference](api/ENHANCED_JSON_SCHEMA.md) for the complete specification.

### Meta-Store System

The meta-store is a singleton MST store managing schema definitions as queryable entities:

- **Self-describing** — Uses Schema → Model → Property hierarchy
- **Access** — `getMetaStore()` returns the singleton
- **Testing** — `createMetaStoreInstance()` creates isolated instances

When you call `schema.set`, the meta-store ingests the schema and tracks its structure for runtime introspection.

### Runtime Store Cache

Each schema can have multiple runtime stores, keyed by location:

- **Location** — A generic primitive (file path, database name, storage prefix)
- **Access** — `getRuntimeStore(schemaId, location)`
- **Registration** — `cacheRuntimeStore(schemaId, store, location)`

Higher-level code maps domain concepts (workspace, tenant) to locations.

### Environment Injection

Services are injected at store creation, not imported directly:

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

// Access in models via getEnv()
const env = getEnv<IEnvironment>(self)
await env.services.persistence.saveEntity(...)
```

This enables the same model code to work with different backends (filesystem, HTTP, in-memory).

### Persistence Abstraction

The `IPersistenceService` interface defines storage operations:

| Implementation | Environment | Purpose |
|----------------|-------------|---------|
| `FileSystemPersistence` | Node.js | File I/O to `.schemas/` directory |
| `NullPersistence` | Testing | In-memory, no persistence |
| `MCPPersistence` | Browser | HTTP bridge to MCP server |

### Composition Mixins

Cross-cutting concerns are added via MST composition:

```typescript
const MyCollection = types.compose(
  BaseCollection,
  CollectionPersistable  // Adds loadAll, saveAll, loadById, saveOne
)
```

`CollectionPersistable` provides automatic CRUD operations that use the injected persistence service.

### View System

Views enable querying and file generation:

- **Query views** — Filter and select from collections, return data
- **Template views** — Nunjucks templates that project data to files

| Tool | Purpose |
|------|---------|
| `view.define` | Register a view definition on a schema |
| `view.execute` | Run a query view, return results |
| `view.project` | Run a template view, write output file |
| `view.delete` | Remove a view definition |

---

## See Also

- [Architecture](ARCHITECTURE.md) — System design with diagrams
- [App Builder Guide](SKILL_USER_GUIDE.md) — Complete skill user walkthrough
- [State API Reference](api/STATE_API.md) — Function signatures and types
- [MCP Tools Reference](api/MCP_TOOLS.md) — All 16 tools documented
