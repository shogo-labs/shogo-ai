# Architectural Context: Layer 2.7 Documentor

## Layer Positioning in 4-Layer Architecture

The app-builder system follows a 4-layer transformation architecture:

```
Layer 1: Discovery
  ├─ Problem understanding
  ├─ Requirements definition
  └─ Acceptance criteria
      ↓
Layer 2: Schema Designer
  ├─ Domain entities
  ├─ Relationships
  └─ Enhanced JSON Schema
      ↓
Layer 2.5: Implementation Spec
  ├─ Modules (what to build)
  ├─ Interfaces (how they connect)
  └─ Tests (how to validate)
      ↓
Layer 2.7: Documentor [THIS LAYER]
  ├─ Architecture (system view)
  ├─ API Reference (interface details)
  ├─ Implementation Guides (how to build)
  ├─ Test Documentation (how to validate)
  └─ Provenance (full trace)
      ↓
Layer 3: Code Generation
  ├─ Implementation code
  ├─ Test implementations
  └─ Deployment artifacts
```

## Why Layer 2.7?

**Documentation is parallel to implementation, not a prerequisite.**

- Layer 2.5 specs can proceed directly to Layer 3 code generation
- Layer 2.7 serves as a **bridge for human understanding**
- Both Layer 2.7 (docs) and Layer 3 (code) consume Layer 2.5 specs
- This parallel structure enables:
  - Documentation-driven development (docs before code)
  - Code-first development (code before docs)
  - Simultaneous generation (docs and code together)

**Key Principle**: Documentation transforms the same spec entities that will be implemented, making docs and code naturally aligned.

## Integration Points

### ← Backward References (Inputs)

Layer 2.7 pulls context from all preceding layers:

**Layer 1: Discovery** → Requirements and problem context
- **Why**: Understand *why* modules exist and what problems they solve
- **Usage**: Include problem statements and requirements in architecture docs
- **Entity**: `DocumentationSession.discoverySession → DiscoverySession`
- **Example**: "The comparison-engine module addresses requirement req-002: 'Compare matched template sections against contract sections to identify textual differences'"

**Layer 2: Schema Designer** → Domain entities and relationships
- **Why**: Document what data structures the system works with
- **Usage**: Generate entity-relationship diagrams, document API inputs/outputs
- **Entity**: `DocumentationSession.appSchemaName` (schema name string)
- **Example**: "The parse_template function returns a `Template` entity with nested `Section[]` references"

**Layer 2.5: Implementation Spec** → Modules, interfaces, tests
- **Why**: Primary source material for all documentation
- **Usage**: Transform specs into human-readable documentation
- **Entity**: `DocumentationSession.implementationSession → ImplementationSession`
- **Example**: ModuleSpecification → Implementation Guide, InterfaceContract → API Reference

### → Forward References (Outputs)

Layer 2.7 provides guidance for downstream layers:

**Layer 3: Code Generation** → Implementation guidance
- **What**: Algorithm strategies, interface signatures, test scenarios
- **How**: Layer 3 reads implementation guides to understand *how* to implement
- **Example**: "The comparison algorithm uses a two-pass fuzzy matching approach with 80% similarity threshold"

**Knowledge Graph** → Pattern documentation
- **What**: Reusable patterns discovered during documentation
- **How**: Successful patterns documented for reuse across projects
- **Example**: "PracticeWorks conditional content pattern: business rules embedded in paragraph styles"

**Obsidian Vault** → Permanent reference material
- **What**: Human-readable guides, architecture decisions
- **How**: Markdown files exported to vault for team reference
- **Example**: Workspace files exported to `Architecture/contract-template-updater/`

### ↔ Horizontal Integration (Same Layer)

**Cross-domain reuse**:
- Transformation patterns are domain-agnostic
- Same methodology works for document-processing, data-pipelines, web-apps
- Elicitation heuristics apply universally

**Session updates**:
- Support regenerating docs when Layer 2.5 specs change
- Pure projection pattern: docs derived entirely from specs + user context
- No incremental updates: regenerate from scratch for consistency

**Composition with other apps**:
- Documentation from multiple sessions can be combined
- Cross-references between app documentations
- Shared glossary and terminology

## Cross-Layer Reference Validation

**Critical Rule**: All cross-layer references must be validated before use.

### Validation Pattern

```python
# Check Layer 2.5 reference exists
impl_session = wavesmith.store_get("ImplementationSession", session_id)
if not impl_session:
    raise ValueError(f"Implementation session {session_id} not found")

# Check Layer 1 reference (optional)
if discovery_session_id:
    disc_session = wavesmith.store_get("DiscoverySession", discovery_session_id)
    if not disc_session:
        warn("Discovery session not found - proceeding without Layer 1 context")

# Check Layer 2 schema exists
available_schemas = wavesmith.schema_list()
if app_schema_name not in [s.name for s in available_schemas]:
    raise ValueError(f"Schema {app_schema_name} not found")
```

### Error Handling

**Missing Layer 1 (Discovery)**:
- Not fatal - documentation can proceed without requirements context
- Warn user that requirement traceability will be limited
- Generate docs from Layer 2.5 entities only

**Missing Layer 2 (Schema)**:
- Not fatal for most docs - architecture and implementation guides don't require schema
- Fatal for entity-relationship diagrams and detailed API docs
- Attempt to load schema via `wavesmith.schema_load(app_schema_name)`

**Missing Layer 2.5 (Implementation Spec)**:
- Fatal - cannot generate documentation without specs
- Provide clear error message with instructions to run implementation-spec skill first

## Evolution and Traceability

### Forward Traceability

Track how requirements flow through layers:

```
Requirement (L1)
  → ModuleSpecification.implementsRequirements (L2.5)
    → DocumentEntity.references.implementsRequirements (L2.7)
      → Code Module (L3)
```

### Backward Traceability

Track implementation back to requirements:

```
Code Module (L3)
  ← DocumentEntity "Implementation Guide" (L2.7)
    ← ModuleSpecification (L2.5)
      ← Requirement (L1)
```

### Provenance Visualization

The provenance artifact (generated via artifacts-builder) visualizes the full chain:
- Interactive exploration of requirements → specs → docs → code
- Click through relationships
- Understand "why was this built this way?"

## Integration with Knowledge System

### Knowledge Scouts (Discovery)

When users ask "what documentation exists for X?":
- Knowledge Scout searches both Obsidian vault and Graphiti graph
- Returns: permanent docs (vault) + recent documentation sessions (graph)
- Identifies gaps: "API docs exist but architecture overview is missing"

### Knowledge Scribe (Curation)

After documentation generation:
- Scribe evaluates: Is this documentation permanent? Reusable?
- If yes → Librarian exports to vault with proper organization
- If no → Remains in Wavesmith as session-specific documentation

### Knowledge Librarian (Vault Management)

Manages permanent documentation:
- Creates architecture decision records (ADRs)
- Organizes guides by domain
- Maintains cross-links between related docs
- Archives obsolete documentation

## Success Criteria for Integration

**Layer 1 Integration**:
- ✅ Requirements traceable from docs back to Layer 1
- ✅ Problem context included in architecture overview
- ✅ Acceptance criteria visible in test documentation

**Layer 2 Integration**:
- ✅ Entity-relationship diagrams match schema definitions
- ✅ API docs reference correct entity types
- ✅ Schema entities validated before documentation

**Layer 2.5 Integration**:
- ✅ 100% module coverage (all modules documented)
- ✅ 100% interface coverage (all interfaces documented)
- ✅ Module dependencies reflected in architecture diagrams
- ✅ Test scenarios formatted for readability

**Layer 3 Integration**:
- ✅ Implementation guides provide sufficient detail for code generation
- ✅ Algorithm strategies clearly explained
- ✅ Interface signatures match Layer 2.5 contracts

**Horizontal Integration**:
- ✅ Patterns documented work across document-processing, data-pipelines, web-apps
- ✅ Methodology applies universally
- ✅ Workspace structure consistent across domains

---

**This context ensures Layer 2.7 integrates cleanly with the broader app-builder system while maintaining its focused purpose: transforming specs into comprehensive, human-readable documentation.**
