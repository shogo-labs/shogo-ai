---
name: app-builder-documentor
description: Transform Layer 2.5 implementation specifications into comprehensive technical documentation including architecture guides, API reference, implementation guides, test documentation, and interactive provenance visualization. This skill should be used after implementation-spec creation when documentation is needed to support Layer 3 code generation or provide human-readable system understanding.
---

# App-Builder Documentor

## Overview

Transform Layer 2.5 implementation specifications into comprehensive, human-readable documentation for developers, QA engineers, and architects. Generate architecture overviews, API references, implementation guides, test documentation, and interactive provenance visualizations showing the full Layer 1 → 2 → 2.5 → 2.7 chain.

**When to use this skill**:
- After running app-builder-implementation-spec to generate Layer 2.5 specs
- Before Layer 3 code generation to provide implementation guidance
- When developers need comprehensive system documentation
- When stakeholders need to understand system architecture
- When traceability from requirements to implementation is needed

**Core capabilities**:
- Architecture documentation with dependency diagrams
- API reference with interface specifications
- Per-module implementation guides
- Test scenario documentation
- Interactive provenance visualization
- Full requirements traceability

---

## 4-Phase Methodology

The documentor skill follows a **methodology-driven** workflow where phases guide *how to think* about documentation generation, not *what to generate*. Each phase applies universally regardless of documentation types requested.

### Phase 1: Contextualization

**Purpose**: Understand what's being documented and why.

**Actions**:
1. Load Layer 2.5 implementation session (required)
2. Load cross-layer context (Layer 1 discovery, Layer 2 schema - optional but recommended)
3. Understand problem domain from entity `details` fields
4. Infer documentation types needed or elicit when ambiguous
5. Create DocumentationSession in Wavesmith

**Key decisions**:
- Which documentation types are needed? (see Elicitation Strategy below)
- Is Layer 1 context available for traceability?
- Is Layer 2 schema needed for entity-relationship diagrams?

**Artifacts**: DocumentationSession entity

**Reference**: Read `references/methodology-guide.md` for Phase 1 details.

---

### Phase 2: Alignment

**Purpose**: Ensure generated docs serve their intended purpose.

**Actions**:
1. Identify target audience (primary: developers implementing Layer 3)
2. Determine appropriate level of detail
3. Map Layer 2.5 entities to documentation structure
4. Validate traceability paths exist
5. Check for gaps (missing cross-layer references)
6. Create DocumentationPlan

**Key validations**:
- Module → Requirements (Layer 1): Traceability exists?
- Interface → Schema Entities (Layer 2): References valid?
- Test → Requirement (Layer 1): Validation path exists?

**Artifacts**: DocumentationPlan entity with coverage map and traceability matrix

**Reference**: Read `references/methodology-guide.md` for Phase 2 details.

---

### Phase 3: Synthesis

**Purpose**: Transform specs into clear, actionable documentation.

**Actions**:
1. Extract evidence from Layer 2.5 entities (modules, interfaces, tests)
2. Apply transformation patterns (see Transformation Patterns section)
3. Generate diagrams (architecture, dataflow, test coverage, ERD)
4. Compose with artifacts-builder skill for provenance visualization
5. Maintain traceability throughout
6. Create DocumentEntity and Diagram records

**Core transformations**:
- ModuleSpecification → Implementation Guide
- InterfaceContract → API Reference
- TestSpecification → Test Documentation
- Module dependencies → Architecture Diagram
- Interface I/O → Data Flow Diagram
- Full session → Provenance Artifact (via artifacts-builder)

**Artifacts**: DocumentEntity[] and Diagram[] entities

**Reference**:
- Read `references/transformation-patterns.md` for algorithms
- Read `references/skill-composition-guide.md` for artifacts-builder integration

---

### Phase 4: Validation & Refinement

**Purpose**: Ensure completeness and quality.

**Actions**:
1. Validate coverage (100% modules/interfaces/tests documented?)
2. Check traceability (requirements → modules → interfaces → tests → docs)
3. Verify cross-references resolve
4. Generate summary and traceability matrix
5. Export to workspace files
6. Offer iterative refinement
7. Mark session complete

**Quality checks**:
- All modules have implementation guides?
- All interfaces have API documentation?
- All tests have formatted scenarios?
- All diagrams generated successfully?
- Provenance artifact created (if requested)?
- Workspace files exported correctly?

**Artifacts**: Workspace markdown files, diagrams, HTML artifacts

**Reference**:
- Read `references/methodology-guide.md` for Phase 4 details
- Read `references/workspace-structure-guide.md` for export specifications

---

## Elicitation Strategy

**Core Principle**: Only elicit when ambiguous. Never default to "all".

### When to Infer (Proceed Without Asking)

**User specifies explicitly**:
- "Generate API documentation" → Infer: api-reference only
- "I need architecture diagrams" → Infer: architecture + diagrams
- "Document the tests" → Infer: test-documentation only

**Context is clear**:
- Simple implementation (1-2 modules, <5 interfaces) → Infer: implementation-guide only
- Public-facing API (many interfaces) → Infer: api-reference + architecture
- Complex system (5+ modules) → Infer: architecture + api-reference + implementation-guide

**Natural language implies scope**:
- "Quick reference" → Infer: api-reference only
- "Developer guide" → Infer: implementation-guide + api-reference
- "System overview" → Infer: architecture only

### When to Elicit (Ask User)

**Ambiguous scope**:
- "Document the contract-template-updater" → What types?
- "Generate docs for session xyz123" → Which aspects?
- "Comprehensive documentation" → All types or selective?

**Complex implementation**:
- 5+ modules with intricate dependencies
- User may want selective documentation

**Elicitation format**:
```
"I can generate the following documentation types:

- Architecture: System overview, module breakdown, dependency diagrams
- API Reference: Interface specifications with inputs/outputs
- Implementation Guides: Per-module development guidance
- Test Documentation: Test scenarios and coverage
- Provenance Visualization: Interactive full-chain traceability

Which types would you like? (You can select multiple)"
```

**Avoid**:
- ❌ "Do you want all documentation?" (biases toward "yes")
- ❌ Defaulting to "all" without asking
- ❌ "Which one?" (implies single selection only)

**Reference**: Read `references/methodology-guide.md` for detailed elicitation heuristics.

---

## Transformation Patterns

All documentation is generated via **evidence-based transformation** from Layer 2.5 entities. Never invent content.

### Pattern 1: ModuleSpecification → Implementation Guide

**Extract**:
- name, purpose, category (input/process/output)
- details (opaque - domain-specific content)
- implementsRequirements (Layer 1 traceability)
- dependsOn (module dependencies)
- interfaces, tests (related entities)

**Generate**:
- Module overview with purpose and category
- Requirements implemented (with traceability)
- Architecture context (dependencies)
- Implementation guidance (from `details` field)
- Algorithm descriptions
- Testing summary

**Reference**: Read `references/transformation-patterns.md` Pattern 1 for algorithm.

---

### Pattern 2: InterfaceContract → API Reference

**Extract**:
- functionName, purpose
- inputs, outputs (opaque - may reference Layer 2 entities)
- errors (opaque - error specifications)
- algorithmStrategy

**Generate**:
- Function signature documentation
- Parameter specifications with types
- Return value documentation
- Error handling guide
- Algorithm strategy explanation
- Usage notes (conceptual, no code)

**Validate**: Schema entity references in inputs/outputs

**Reference**: Read `references/transformation-patterns.md` Pattern 2 for algorithm.

---

### Pattern 3: TestSpecification → Test Documentation

**Extract**:
- scenario, testType (unit/integration/acceptance)
- given, when, then (abstract preconditions/action/outcomes)
- validatesRequirement, validatesAcceptanceCriteria

**Generate**:
- Formatted Given/When/Then scenario
- Test type label and description
- Traceability to requirements
- Testing notes

**Reference**: Read `references/transformation-patterns.md` Pattern 3 for algorithm.

---

### Pattern 4: Module Dependencies → Architecture Diagram

**Extract**:
- All modules with names, categories, purposes
- Module.dependsOn relationships

**Generate**:
- Mermaid graph showing module dependency structure
- Category-based node styling (input/process/output)
- Clear directional flow

**Reference**: Read `references/transformation-patterns.md` Pattern 4 for Mermaid generation.

---

### Pattern 5: Interface I/O → Data Flow Diagram

**Extract**:
- Interface inputs/outputs with entity references
- Entity flow through interface chain

**Generate**:
- Mermaid flowchart showing data flow
- Entity transformations
- User-facing I/O

**Reference**: Read `references/transformation-patterns.md` Pattern 5 for algorithm.

---

### Pattern 6: Full Session → Provenance Artifact

**Extract**:
- Layer 1: Discovery context (problem, requirements)
- Layer 2: Schema entities and relationships
- Layer 2.5: Modules, interfaces, tests
- Layer 2.7: Generated documentation

**Generate** (via artifacts-builder skill composition):
- Interactive HTML artifact
- Full chain visualization with clickable relationships
- Requirement → Module → Interface → Test → Documentation traceability
- Rich context panels for each entity

**Invocation**:
```
Skill: artifacts-builder

Generate an interactive HTML artifact visualizing the full provenance chain for [app-name].

[Provide gathered data from all layers]
[Specify interactive requirements]
```

**Reference**: Read `references/skill-composition-guide.md` for complete invocation pattern.

---

### Pattern 7: Tests + Requirements → Coverage Matrix

**Extract**:
- All tests with validatesRequirement links
- All requirements

**Generate**:
- Mermaid graph showing requirement → test relationships
- Coverage percentage calculations

**Reference**: Read `references/transformation-patterns.md` Pattern 7 for algorithm.

---

### Pattern 8: Schema Entities → Entity-Relationship Diagram

**Extract**:
- Layer 2 schema entities
- Entity relationships and references

**Generate**:
- Mermaid ER diagram
- Entity relationships with cardinality

**Requires**: Layer 2 schema loaded via `wavesmith.schema_get(appSchemaName)`

**Reference**: Read `references/transformation-patterns.md` Pattern 8 for algorithm.

---

## Skill Composition

### artifacts-builder (Provenance Visualization)

**Purpose**: Generate rich interactive HTML artifact showing full Layer 1→2→2.5→2.7 chain.

**When**: User requests "provenance" documentation type.

**Pattern**:
1. Gather data from all layers
2. Build traceability chains
3. Invoke artifacts-builder skill with comprehensive prompt
4. Validate returned HTML
5. Create DocumentEntity with HTML content
6. Export to `workspace/artifacts/provenance-visualization.html`

**Fallback**: If artifacts-builder fails, generate simple HTML visualization.

**Reference**: Read `references/skill-composition-guide.md` for complete specifications.

---

### knowledge-scout (Discovery)

**Purpose**: Find discovery session by name when user doesn't provide ID.

**When**: User says "document contract-template-updater" without session IDs.

**Pattern**: Invoke knowledge-scout to search Wavesmith for DiscoverySession by name.

**Reference**: Read `references/skill-composition-guide.md` for pattern.

---

### knowledge-scribe (Post-Generation)

**Purpose**: Optionally preserve documentation in Obsidian vault.

**When**: User explicitly requests "save to vault" or documentation is broadly reusable.

**Pattern**: Invoke knowledge-scribe to evaluate and preserve worthy documentation.

**Note**: Do not invoke automatically. Let user decide.

**Reference**: Read `references/skill-composition-guide.md` for pattern.

---

## Workspace Structure

Documentation is dual-stored: Wavesmith entities (queryable) + workspace files (human-browsable).

### Workspace Root

```
.schemas/app-builder-documentor/workspaces/{session-name}/
```

### Folder Structure

```
{session-name}/
├── README.md                          # Documentation hub
├── architecture/
│   ├── overview.md                    # System architecture
│   ├── modules.md                     # Module breakdown
│   └── diagrams/
│       ├── system-architecture.mmd
│       ├── data-flow.mmd
│       ├── test-coverage.mmd
│       └── entity-relationships.mmd
├── api/
│   ├── index.md
│   └── {module-name}/
│       └── {function-name}.md
├── guides/
│   └── implementation/
│       └── {module-name}.md
├── tests/
│   └── {module-name}/
│       └── scenarios.md
├── traceability/
│   └── requirements-coverage.md
└── artifacts/
    └── provenance-visualization.html
```

**Export workflow**: During Phase 4, export all DocumentEntity/Diagram entities to markdown/Mermaid files.

**Reference**: Read `references/workspace-structure-guide.md` for complete specifications, file formats, and naming conventions.

---

## Architectural Context

### Layer 2.7 Positioning

Documentation sits **parallel** to Layer 3 code generation:

```
Layer 2.5 (Implementation Spec)
    ├─→ Layer 2.7 (Documentation) → Guides Layer 3
    └─→ Layer 3 (Code Generation) → Consumes specs
```

**Why parallel?**
- Documentation can be generated before, during, or after code
- Both consume the same Layer 2.5 specs
- Documentation guides Layer 3 implementation
- Pure projection: regenerate docs anytime specs change

### Cross-Layer Integration

**Backward References**:
- Layer 1 (Discovery): Requirements context ("why?")
- Layer 2 (Schema): Entity definitions ("what data?")
- Layer 2.5 (Implementation Spec): Primary source ("what to build?")

**Forward Guidance**:
- Layer 3 (Code Generation): Implementation guidance
- Knowledge Graph: Pattern documentation
- Obsidian Vault: Permanent reference material

**Reference**: Read `references/architectural-context.md` for complete integration specifications.

---

## Success Criteria

### Session 1 Target

- **≤1 interventions**: Minimal user prompting
- **100% coverage**: All modules/interfaces/tests documented
- **Correct elicitation**: Only when ambiguous
- **Successful composition**: artifacts-builder invoked successfully
- **Clean workspace**: Files exported with proper structure

### Quality Metrics

- **Traceability**: 100% docs link to source entities
- **No invented content**: All from Layer 2.5
- **Domain-agnostic**: Works for documents, pipelines, web apps
- **Human-readable**: Clear markdown, understandable diagrams

---

## Common Pitfalls to Avoid

### ❌ Don't

1. Default to "all" without checking user needs
2. Invent content not in Layer 2.5 entities
3. Skip validation of cross-layer references
4. Generate code examples (that's Layer 3's job)
5. Hardcode domain patterns (use opaque fields)
6. Forget traceability links
7. Skip elicitation when scope is ambiguous

### ✅ Do

1. Infer when possible to reduce friction
2. Elicit when ambiguous to meet user needs
3. Validate all references before documenting
4. Use transformation patterns consistently
5. Maintain traceability throughout
6. Export clean workspace structure
7. Offer refinement after generation

---

## Using Bundled References

### references/architectural-context.md

**When to read**: During Phase 1 (Contextualization) to understand Layer 2.7 positioning and cross-layer integration points.

**Contains**: Layer positioning, integration patterns, cross-layer reference validation, success criteria.

---

### references/transformation-patterns.md

**When to read**: During Phase 3 (Synthesis) when applying transformations.

**Contains**: Complete algorithms for all 8 transformation patterns with code examples and domain-agnostic principles.

---

### references/methodology-guide.md

**When to read**: When unclear on phase actions, elicitation strategy, or phase transitions.

**Contains**: Deep dive into 4 phases, elicitation heuristics, success metrics, phase transitions, common pitfalls.

---

### references/skill-composition-guide.md

**When to read**: When invoking artifacts-builder or other composed skills.

**Contains**: Invocation patterns, data gathering, result integration, error handling, provenance specifications.

---

### references/workspace-structure-guide.md

**When to read**: During Phase 4 (Validation) when exporting workspace files.

**Contains**: Folder structure, file specifications, naming conventions, markdown standards, export workflow.

---

## Quick Start

**Typical invocation**:
```
User: "Generate documentation for the contract-template-updater implementation"

Agent:
1. Load implementation session "contract-template-updater"
2. Detect ambiguous scope → Elicit doc types
3. User responds: "All of them"
4. Proceed through 4 phases:
   - Contextualization: Load Layer 2.5, check cross-layer context
   - Alignment: Map entities, validate traceability
   - Synthesis: Generate all doc types + diagrams + provenance
   - Validation: Check coverage, export workspace, mark complete
5. Present summary with workspace path
```

**Time estimate**: ~10 minutes for typical implementation (3-5 modules)

---

## Example Workflow

**User Request**: "Generate comprehensive documentation for session contract-template-updater-spec"

**Phase 1**: Load session, check cross-layer context, infer scope is ambiguous, elicit

**Elicitation**: "I can generate architecture, API reference, implementation guides, test docs, and provenance. Which types?"

**User**: "All of them"

**Phase 2**: Map 3 modules, 6 interfaces, 12 tests to docs, validate traceability, create plan

**Phase 3**:
- Generate 3 implementation guides (1 per module)
- Generate 6 API references (1 per interface)
- Generate 3 test docs (1 per module)
- Generate 1 architecture doc with module overview
- Generate 4 diagrams (architecture, dataflow, coverage, ERD)
- Invoke artifacts-builder for provenance
- Create 17 DocumentEntity + 4 Diagram entities

**Phase 4**:
- Validate 100% coverage
- Check traceability (12/12 tests trace to requirements)
- Generate traceability matrix
- Export 25 workspace files
- Present summary

**Result**: Complete documentation set in Wavesmith + workspace files ready for git

---

**This skill transforms Layer 2.5 specs into comprehensive, developer-ready documentation following evidence-based, domain-agnostic patterns.**
