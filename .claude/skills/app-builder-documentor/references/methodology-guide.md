# Methodology Guide: 4-Phase Documentation Workflow

## Overview

The documentor skill uses a **methodology-driven** approach where phases guide *how to think* about documentation, not *what to generate*. Each phase applies universally regardless of whether you're generating architecture docs, API reference, implementation guides, test docs, or provenance artifacts.

---

## Phase 1: Contextualization

**Purpose**: Deeply understand what's being documented and why.

### Actions

1. **Load Implementation Session** (Layer 2.5)
   - Retrieve ImplementationSession by ID or name
   - Extract modules, interfaces, tests
   - Note workspace path and current phase

2. **Load Cross-Layer Context**
   - Layer 1 (Discovery): Optional but recommended
     - Problem statement, requirements, acceptance criteria
     - Provides "why" context for documentation
   - Layer 2 (Schema): Required for entity-relationship diagrams
     - Application schema entities and relationships
     - Needed for API documentation with entity references

3. **Understand Problem Domain**
   - What problem does this implementation solve?
   - What are the key entities and relationships?
   - What patterns are being used (from module `details` fields)?

4. **Determine Documentation Types Needed**
   - **Infer from context**:
     - Simple implementation (1-2 modules) → guides only
     - Complex system (5+ modules) → architecture + guides + API
     - Public API → prioritize API reference
     - Internal tool → prioritize implementation guides
   - **Elicit when ambiguous** (see Elicitation Strategy below)

5. **Create DocumentationSession**
   - Initialize session with inferred/elicited types
   - Set currentPhase to "contextualization"
   - Create workspace path

### Success Criteria

- ✅ All Layer 2.5 entities loaded successfully
- ✅ Cross-layer context available (or explicitly noted as unavailable)
- ✅ Problem domain understood
- ✅ Documentation types determined (inferred or elicited)
- ✅ DocumentationSession created

---

## Phase 2: Alignment

**Purpose**: Ensure generated docs serve their intended purpose.

### Actions

1. **Identify Target Audience Needs**
   - **Primary audience**: Developers implementing Layer 3 code
   - **Secondary audiences**: QA (test docs), Architects (system design), Stakeholders (exec summary)
   - **Focus**: What information does Layer 3 need to implement correctly?

2. **Determine Level of Detail Appropriate**
   - **High-level overview**: For architecture docs
   - **Detailed specifications**: For API reference
   - **Implementation guidance**: For module guides
   - **Abstract scenarios**: For test docs (no code!)

3. **Map Layer 2.5 Entities to Documentation Structure**
   - **Architecture**: All modules + dependencies
   - **API Reference**: All interfaces (1:1 mapping)
   - **Implementation Guides**: All modules (1:1 mapping)
   - **Test Documentation**: All tests (grouped by module)
   - **Provenance**: Full session + cross-layer context

4. **Validate Traceability Paths Exist**
   - Module → Requirements (Layer 1)
   - Interface → Schema Entities (Layer 2)
   - Test → Requirement + Acceptance Criteria (Layer 1)
   - Check for broken references, warn if found

5. **Check for Gaps or Ambiguities**
   - Missing Layer 1 context? → Warn, proceed without traceability
   - Missing Layer 2 schema? → Warn, skip entity-relationship diagram
   - Module has no interfaces? → Note in documentation
   - Interface references unknown entity? → Warn, document as "unknown entity"

6. **Create DocumentationPlan**
   - Coverage map: which modules/interfaces/tests to document
   - Traceability matrix: requirement → module → interface → test
   - Composed skills: list of skills to invoke (e.g., artifacts-builder)

### Success Criteria

- ✅ Target audience identified
- ✅ Level of detail determined
- ✅ Entity-to-doc mapping complete
- ✅ Traceability paths validated
- ✅ Gaps and ambiguities documented
- ✅ DocumentationPlan created

---

## Phase 3: Synthesis

**Purpose**: Transform specs into clear, actionable documentation.

### Actions

1. **Extract Evidence from Layer 2.5 Entities**
   - For each module: name, purpose, category, details, requirements
   - For each interface: function name, purpose, inputs, outputs, errors, algorithm
   - For each test: scenario, given/when/then, validates requirement

2. **Apply Transformation Patterns** (see transformation-patterns.md)
   - ModuleSpecification → Implementation Guide
   - InterfaceContract → API Reference
   - TestSpecification → Test Documentation
   - Module dependencies → Architecture Diagram
   - Interface I/O chain → Data Flow Diagram
   - Test coverage → Coverage Matrix
   - Schema entities → Entity-Relationship Diagram

3. **Generate Diagrams**
   - **Architecture Diagram**: Module dependency graph with categories
   - **Data Flow Diagram**: Interface I/O chain showing entity flow
   - **Test Coverage Matrix**: Requirements → Tests mapping
   - **Entity-Relationship Diagram**: Layer 2 schema visualization

4. **Compose with Other Skills**
   - **artifacts-builder**: For provenance visualization
     - Gather full chain: Layer 1 → 2 → 2.5 → 2.7
     - Generate interactive HTML artifact
     - Embed in provenance DocumentEntity

5. **Maintain Traceability**
   - Every DocumentEntity includes `references` field
   - Link back to source ModuleSpecification/InterfaceContract/TestSpecification
   - Link to Layer 1 requirements where applicable
   - Link to Layer 2 schema entities where applicable

6. **Create DocumentEntity and Diagram Records**
   - Generate markdown content for text docs
   - Generate Mermaid source for diagrams
   - Populate references field with traceability
   - Set metadata (format, audience, etc.)

### Success Criteria

- ✅ All requested doc types generated
- ✅ All evidence extracted (no invented content)
- ✅ Transformation patterns applied correctly
- ✅ Diagrams generated (architecture, dataflow, coverage, ERD)
- ✅ Provenance artifact created (if requested)
- ✅ Traceability maintained throughout
- ✅ DocumentEntity/Diagram records created in Wavesmith

---

## Phase 4: Validation & Refinement

**Purpose**: Ensure completeness and quality.

### Actions

1. **Validate Coverage**
   - **Modules**: 100% documented? Check against implementation session
   - **Interfaces**: 100% documented? Check against all module interfaces
   - **Tests**: 100% documented? Check against all module tests
   - **Gaps**: Identify missing documentation, if any

2. **Check Traceability**
   - Requirements → Modules: All requirements have module coverage?
   - Modules → Interfaces: All modules have interface documentation?
   - Interfaces → Schema Entities: All entity references valid?
   - Tests → Requirements: All tests trace back to requirements?

3. **Verify Cross-References Work**
   - Layer 1 references resolve?
   - Layer 2 references resolve?
   - Layer 2.5 references resolve?
   - Diagram references complete?

4. **Generate Summary/Index**
   - **Traceability Matrix**: Table showing requirement → module → interface → test
   - **Documentation Index**: List of all generated docs with links
   - **Coverage Report**: Percentage coverage for modules/interfaces/tests

5. **Export to Workspace**
   - Create folder structure (see workspace-structure-guide.md)
   - Export markdown files for text docs
   - Export Mermaid files for diagrams
   - Export HTML for provenance artifact
   - Generate README.md with index

6. **Offer Iterative Refinement**
   - Present summary to user
   - Ask: "Would you like to regenerate any specific documentation?"
   - Support selective regeneration (pure projection)

7. **Mark Session Complete**
   - Update DocumentationSession.currentPhase = "complete"
   - Set completedAt timestamp
   - Generate final report

### Success Criteria

- ✅ 100% coverage validated (or gaps documented)
- ✅ Traceability matrix complete
- ✅ Cross-references verified
- ✅ Summary and index generated
- ✅ Workspace files exported
- ✅ User offered refinement option
- ✅ Session marked complete

---

## Elicitation Strategy: When to Ask vs. Proceed

**Core Principle**: Only elicit when ambiguous. Never default to "all".

### Inference Heuristics

**Proceed without elicitation when**:

1. **User specifies doc type explicitly**
   - "Generate API documentation" → Infer: api-reference only
   - "I need architecture diagrams" → Infer: architecture + diagrams
   - "Document the tests" → Infer: test-documentation only

2. **Session context is clear**
   - Simple implementation (1-2 modules, <5 interfaces) → Infer: implementation-guide only
   - Public-facing API (many interfaces, complex I/O) → Infer: api-reference + architecture
   - Internal tool with tests → Infer: implementation-guide + test-documentation

3. **Natural language implies scope**
   - "Comprehensive documentation" → Elicit (ambiguous scope)
   - "Quick reference" → Infer: api-reference only
   - "Developer guide" → Infer: implementation-guide + api-reference

### Elicitation Triggers

**Elicit when**:

1. **Ambiguous scope**
   - "Document the contract-template-updater" → What types?
   - "Generate docs for session xyz123" → Which aspects?

2. **Complex implementation**
   - 5+ modules, 10+ interfaces, complex dependencies
   - User may want selective documentation

3. **First-time user**
   - No history of doc generation preferences
   - Help them understand options

### Elicitation Pattern

**Format**:
```
"I can generate the following documentation types:

- Architecture: System overview, module breakdown, dependency diagrams
- API Reference: Interface specifications with inputs/outputs
- Implementation Guides: Per-module development guidance
- Test Documentation: Test scenarios and coverage
- Provenance Visualization: Interactive full-chain traceability

Which types would you like? (You can select multiple, or I can generate all of them)"
```

**Avoid**:
- ❌ "Do you want all documentation?" (biases toward "yes")
- ❌ "Which one do you want?" (implies single selection)
- ❌ Defaulting to "all" without asking

**Good examples**:
- ✅ "Based on your implementation (3 modules, 6 interfaces), I recommend: architecture, API reference, and implementation guides. Generate these?"
- ✅ "This is a simple implementation. I'll generate implementation guides for each module. Need anything else?"

### User Response Handling

**"All of them"** → Generate all 5 types

**"Just the API docs"** → api-reference only

**"Architecture and guides"** → architecture + implementation-guide

**"Whatever you think is needed"** → Use inference heuristics above

### Selective Regeneration

Support iterative refinement:

```
User: "The API docs are great, but can you add architecture diagrams?"

Agent: "I'll add architecture and data flow diagrams while keeping the existing API documentation."
```

---

## Phase Transitions

Phases can be non-linear in practice:

### Standard Flow
```
Contextualization → Alignment → Synthesis → Validation → Complete
```

### Refinement Loop
```
Validation → [User requests changes] → Synthesis → Validation → Complete
```

### Error Recovery
```
Synthesis → [Missing Layer 2 schema] → Contextualization → Alignment → Synthesis
```

**Key Principle**: Each phase can loop back to earlier phases if needed, but must ultimately progress forward to completion.

---

## Success Metrics

### Validation Criteria (Session 1 Target)

- **≤1 interventions**: Minimal user prompting required
- **100% coverage**: All modules/interfaces/tests documented
- **Correct elicitation**: Only when ambiguous, never defaulting to "all"
- **Successful composition**: artifacts-builder invoked correctly
- **Clean workspace**: Files exported with proper structure

### Quality Metrics

- **Traceability**: 100% of docs link back to source entities
- **No invented content**: All content extracted from Layer 2.5
- **Domain-agnostic**: Patterns work for docs, pipelines, web apps
- **Human-readable**: Markdown is clear, diagrams are understandable

### Performance Metrics (Target)

- **Phase 1 (Contextualization)**: <2 minutes
- **Phase 2 (Alignment)**: <1 minute
- **Phase 3 (Synthesis)**: <5 minutes (depends on size)
- **Phase 4 (Validation)**: <2 minutes
- **Total**: <10 minutes for typical implementation (3-5 modules)

---

## Common Pitfalls to Avoid

### ❌ Don't

1. **Default to "all"** without checking if user wants everything
2. **Invent content** not present in Layer 2.5 entities
3. **Skip validation** of cross-layer references
4. **Generate code examples** (that's Layer 3's job)
5. **Hardcode domain patterns** (use opaque fields instead)
6. **Forget traceability** (always link back to source entities)
7. **Skip elicitation** when scope is truly ambiguous

### ✅ Do

1. **Infer when possible** to reduce friction
2. **Elicit when ambiguous** to ensure user gets what they need
3. **Validate all references** before documenting
4. **Use transformation patterns** consistently
5. **Maintain traceability** throughout
6. **Export clean workspace** with proper structure
7. **Offer refinement** after initial generation

---

**This methodology ensures consistent, high-quality documentation generation across all domains while minimizing user friction through smart inference and selective elicitation.**
