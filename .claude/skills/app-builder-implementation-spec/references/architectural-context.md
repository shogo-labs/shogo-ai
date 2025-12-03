# Architectural Context: Layer 2.5 Implementation Specifications

## The 4-Layer Meta App-Building System

This implementation specification layer is part of a **meta app-building system** designed to be domain-agnostic and work across document processing, data pipelines, web applications, and more.

### Complete Layer Architecture

```
Layer 1: Discovery (Problem → Requirements)
├─ Input: User problem statement, artifacts
├─ Process: Analysis, requirement extraction, solution design
├─ Output: Requirements, acceptance criteria, solution phases
└─ Status: ✅ Validated (Session 3: 0 interventions)

Layer 2: Schema Bridge (Requirements → Domain Model)
├─ Input: Discovery outputs (requirements, solution phases)
├─ Process: Entity extraction, relationship modeling, constraint mapping
├─ Output: Enhanced JSON Schema with entities and relationships
└─ Status: ✅ Validated (Session 3: 0 interventions)

Layer 2.5: Implementation Spec (Domain Model → Implementation Plan) [THIS LAYER]
├─ Input: Discovery outputs + Application schema
├─ Process: Module extraction, interface definition, test generation
├─ Output: Module specs, interface contracts, test scenarios
└─ Status: 🔨 In Development

Layer 3: Code Generation (Implementation Plan → Executable Code)
├─ Input: Implementation specs, schema
├─ Process: Code stub generation, boilerplate creation
├─ Output: Executable code with tests
└─ Status: ⚠️ Partial (build_types.py exists)
```

## Why Layer 2.5 Exists

### The Gap Between Schema and Code

**Without Layer 2.5**:
```
Layer 2 Schema → ??? → Layer 3 Code
```

**Questions left unanswered**:
- What modules/components should be built?
- What are the function signatures?
- How do modules interact?
- What tests validate the implementation?

**With Layer 2.5**:
```
Layer 2 Schema → Implementation Spec → Layer 3 Code
                 ├─ Module specifications
                 ├─ Interface contracts
                 └─ Test specifications
```

**Questions now answered**:
- Modules extracted from solution phases
- Interfaces defined with inputs/outputs referencing schema entities
- Tests generated from acceptance criteria
- Traceability maintained across all layers

### The TDD Connection

Layer 2.5 enables **Test-Driven Development** at the specification level:

1. **Requirements** (Layer 1) → What needs to be built
2. **Schema** (Layer 2) → What data structures are needed
3. **Implementation Spec** (Layer 2.5) → What interfaces and tests
4. **Code** (Layer 3) → Implement to pass tests

**Flow**:
```
Discovery Requirement: "Must preserve PW markers during parsing"
    ↓
Schema Entity: Template { pwMarkers: PWMarker[] }
    ↓
Interface Contract: parse_template(path) → Template
    ↓
Test Specification:
  Given: "Template contains PW markers"
  When: "parse_template is called"
  Then: "Template.pwMarkers array is populated"
    ↓
Code Implementation: Implement parse_template to pass test
```

## How Layers Integrate

### Cross-Layer References

**Layer 2.5 references Layer 1**:
```javascript
ModuleSpecification {
  implementsRequirements: ["req-001", "req-002"]  // Layer 1 references
}

TestSpecification {
  validatesRequirement: "req-003",  // Layer 1 reference
  validatesAcceptanceCriteria: "Must preserve formatting"  // Layer 1 criterion
}
```

**Layer 2.5 references Layer 2**:
```javascript
InterfaceContract {
  outputs: {
    type: "Template",  // Layer 2 schema entity
    schemaReference: "contract-template-updater.Template"
  }
}
```

**Layer 3 uses Layer 2.5**:
```python
# Code generator reads Layer 2.5 specs
interface = load_interface("parse_template")
def parse_template(template_path: str) -> Template:
    """Generated from interface contract"""
    # Implementation guided by interface.algorithmStrategy
    # Tests generated from test specifications
```

### Data Flow Across Layers

```
User Problem
    ↓
Layer 1: Discovery
    ├─ DiscoverySession
    ├─ Requirements (req-001, req-002, ...)
    └─ SolutionProposal (phases: ["Parser", "Comparison", ...])
    ↓
Layer 2: Schema Bridge
    ├─ Enhanced JSON Schema
    └─ Entities (Template, Contract, ComparisonRun)
    ↓
Layer 2.5: Implementation Spec [THIS LAYER]
    ├─ ModuleSpecification (template-parser, comparison-engine)
    ├─ InterfaceContract (parse_template, compare_sections)
    └─ TestSpecification (Given/When/Then scenarios)
    ↓
Layer 3: Code Generation
    ├─ Function stubs (def parse_template(...))
    ├─ Test implementations (test_parse_template_with_pw_markers)
    └─ Module scaffolding (template_parser/ directory)
    ↓
Working Application
```

## Design Principles

### 1. Runtime as Projection Over Intent

Each layer is a **projection** of the layer above, not a copy:

- **Layer 1 → Layer 2**: Requirements project into domain entities
- **Layer 2 → Layer 2.5**: Entities project into implementation modules
- **Layer 2.5 → Layer 3**: Specifications project into executable code

**All projections maintain traceability** via references.

### 2. Domain-Agnostic via Opaque Fields

Layer 2.5 uses **opaque fields** to adapt to any domain:

**ModuleSpecification.details**:
```javascript
// Document processing
{ algorithm: "DOCX parsing", libraries: ["python-docx"] }

// Data pipeline
{ connector: "Salesforce API", polling: "5min" }

// Web application
{ framework: "React", stateManagement: "Context API" }
```

**Pattern**: Structural fields (name, purpose, category) are universal. Domain details are opaque objects.

### 3. Evidence-Based Extraction

Layer 2.5 **never assumes domain structure**. Everything is extracted from evidence:

- **Modules** extracted from `SolutionProposal.phases`
- **Interfaces** inferred from module categories and naming patterns
- **Tests** generated from `Requirement.acceptanceCriteria`

**No hardcoded templates**. Every domain is unique.

### 4. Queryability for Multiple Consumers

Layer 2.5 specs are stored in **Wavesmith entities** (not just files) because they have multiple consumers:

**Consumers**:
- **Developers**: Read module specs to understand what to build
- **Code generators**: Query interfaces to generate function stubs
- **QA**: Query tests to understand validation scenarios
- **Project managers**: Query traceability to track coverage

**Query examples**:
```javascript
// Find all modules implementing a requirement
modules = store.list("ModuleSpecification", {
  implementsRequirements: { $contains: "req-001" }
})

// Find all interfaces for a module
interfaces = store.list("InterfaceContract", {
  module: "template-parser"
})

// Find all tests for a module
tests = store.list("TestSpecification", {
  module: "template-parser"
})
```

### 5. Workspace Hybrid Pattern

Like Layer 1 (Discovery), Layer 2.5 uses a **hybrid approach**:

**Entities** (queryable via Wavesmith MCP):
- `ImplementationSession`, `ModuleSpecification`, `InterfaceContract`, `TestSpecification`
- Structured, queryable, traceable
- Source of truth

**Workspace Artifacts** (human-readable files):
- `overview.md` (specification summary)
- `modules/*.md` (module details)
- `interfaces/contracts.yaml` (interface contracts)
- `tests/scenarios.md` (test scenarios)
- `diagrams/architecture.md` (module dependencies)

**Relationship**: Artifacts are **projections of entities** (generated from entity data).

## Validation Approach

Layer 2.5 follows the same **TDD validation pattern** as Layer 1 and Layer 2:

**Session 1 (Baseline)**:
- Run skill on reference case (e.g., contract-template-updater)
- Track interventions required
- Document friction points

**Session 2 (Refinement)**:
- Refine skill based on Session 1 findings
- Reduce intervention count
- Improve autonomous execution

**Session 3 (Validation)**:
- Target: **0 interventions**
- Demonstrates skill can execute end-to-end autonomously
- Validates Layer 2.5 design

**Success Criteria** (matching Layer 1 and Layer 2):
- ✅ All entities created (modules, interfaces, tests)
- ✅ Workspace artifacts generated
- ✅ Traceability maintained (requirements → modules → interfaces → tests)
- ✅ 0 interventions (full autonomous execution)

## Integration with Existing Tools

### Wavesmith MCP Integration

Layer 2.5 is **Wavesmith-first**:

```javascript
// Load schemas
wavesmith.schema_load("app-builder-discovery")  // Layer 1
wavesmith.schema_load("app-builder-implementation-spec")  // Layer 2.5
wavesmith.schema_load(app_schema_name)  // Layer 2 (application schema)

// Create entities
wavesmith.store_create("ImplementationSession", {...})
wavesmith.store_create("ModuleSpecification", {...})
wavesmith.store_create("InterfaceContract", {...})
wavesmith.store_create("TestSpecification", {...})

// Query entities
wavesmith.store_list("ModuleSpecification", {session: "sess-001"})
wavesmith.store_get("InterfaceContract", "interface-001")
```

**No direct file writes**. Wavesmith handles persistence.

### Discovery Workspace Integration

Layer 2.5 **reads from** Discovery workspace:

```bash
# Discovery workspace structure
.schemas/app-builder-discovery/workspaces/{session-name}/
├── artifacts/  # Uploaded files analyzed during discovery
└── temp_analysis/  # Analysis outputs
```

Layer 2.5 can reference these files to enrich specifications (e.g., extract enum values from analyzed artifacts).

### Schema File Integration

Layer 2.5 **references** Layer 2 schema:

```bash
# Application schema location
.schemas/{app-schema-name}/schema.json
```

Layer 2.5 loads this schema to:
- Extract entity types for interface contracts
- Validate schema entity references
- Understand domain model structure

## Evolution and Maintenance

### When Layer 2.5 Changes

**Schema changes** (adding entity types or fields):
```javascript
// Update schema via Wavesmith MCP
wavesmith.schema_set("app-builder-implementation-spec", updated_schema)
```

**Skill changes** (workflow improvements):
- Update SKILL.md
- Update reference files
- Re-run validation sessions

**Pattern changes** (new transformation algorithms):
- Update `references/transformation-patterns.md`
- Test against multiple domains

### When Upstream Changes

**Layer 1 changes** (Discovery schema evolves):
- Layer 2.5 queries may need updates (if discovery entity structure changes)
- References to `DiscoverySession`, `Requirement`, etc. may need adjustment

**Layer 2 changes** (Schema format evolves):
- Layer 2.5 schema loading may need updates
- Interface contract references may need adjustment

**Mitigation**: **Versioned schemas** and **backward compatibility** strategies.

## Comparison with Other Approaches

### vs. Direct Code Generation from Schema

**Without Layer 2.5**:
```
Schema → Code Generator → Code
```

**Problems**:
- No intermediate planning step
- No module boundaries defined
- No test specifications
- No traceability to requirements

**With Layer 2.5**:
```
Schema → Implementation Spec → Code Generator → Code
```

**Benefits**:
- Module boundaries explicit
- Interfaces well-defined
- Tests specified upfront
- Full traceability maintained

### vs. Manual Implementation Planning

**Manual approach**:
- Developer reads requirements
- Developer reads schema
- Developer writes design doc
- Developer implements code

**Problems**:
- Inconsistent format
- No queryability
- Easy to skip traceability
- Hard to validate completeness

**Layer 2.5 approach**:
- Skill reads requirements and schema
- Skill generates structured specs
- Specs are queryable entities
- Traceability is enforced

**Benefits**:
- Consistent format across projects
- Queryable for coverage analysis
- Traceability by design
- Validation is systematic

## Future Directions

### Layer 3 Integration (Next Phase)

Once Layer 2.5 is validated, Layer 3 (Code Generation) can:

1. **Read interface contracts** to generate function stubs
2. **Read test specifications** to generate test implementations
3. **Read module specs** to generate directory structure
4. **Maintain traceability** back to Layer 2.5, Layer 2, and Layer 1

**Example**:
```python
# Layer 3 code generator
def generate_module_code(module_spec: ModuleSpecification):
    interfaces = load_interfaces(module_spec.id)
    tests = load_tests(module_spec.id)

    # Generate function stubs from interfaces
    for interface in interfaces:
        generate_function_stub(interface)

    # Generate test implementations from test specs
    for test in tests:
        generate_test_implementation(test)
```

### Cross-Domain Validation

After validating with KPMG (document processing), validate Layer 2.5 with:
- **Data pipeline** case study
- **Web application** case study
- **Automation workflow** case study

**Goal**: Confirm opaque fields pattern works across all domains.

### Tooling Integration

Future integrations:
- **IDE plugins**: Show implementation specs in editor
- **Code generators**: Read specs to generate boilerplate
- **CI/CD**: Validate code coverage matches spec coverage
- **Documentation generators**: Generate API docs from interface contracts

---

## Summary

Layer 2.5 (Implementation Specification) is the **critical bridge** between domain modeling (Layer 2) and code implementation (Layer 3). It provides:

- **Module specifications** defining what to build
- **Interface contracts** defining function signatures
- **Test specifications** defining validation scenarios
- **Full traceability** across all layers

The layer is designed to be **domain-agnostic**, **queryable**, and **evidence-based**, following the same validation approach as Layer 1 and Layer 2.

**Key Insight**: By adding this layer, the meta app-building system moves from "schema to code" to **"requirements to schema to specification to code"** with full traceability at every step.
