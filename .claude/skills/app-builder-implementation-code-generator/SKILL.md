---
name: app-builder-implementation-code-generator
description: Transform Layer 2.5 implementation specifications into executable Python code with type-safe function stubs (NotImplementedError bodies only) and pytest test scaffolding, creating TDD-ready projects grounded in schemas. Uses template-driven projection to materialize spec data efficiently with strong traceability and zero duplication. Use when implementation specs are complete and code generation is requested. Proactively use when users ask to implement or code a spec'd system, or when users indicate readiness to proceed to the code generation phase after completing implementation specifications.
---

# App-Builder Implementation Code Generator

## Overview

Generate executable, type-safe Python code from Layer 2.5 implementation specifications. Transform modules, interfaces, and tests into function stubs, pytest scaffolding, and Pydantic models - creating a TDD-ready project where tests fail predictably (RED phase) and developers implement the GREEN phase.

**Core Philosophy**: Provide safe scaffolding, not intelligent implementation. Generate minimal, validated code following the proven kpmg-contract-parser pattern.

## When to Use This Skill

**Invoke when**:
- User requests code generation from implementation specs
- Implementation Session exists and is complete (Layer 2.5)
- Target language is Python (Session 1 baseline)
- User says:
  - "generate code", "implement the specs", "create Python project", "build the stubs"
  - "proceed to code generation", "ready for code generation phase", "start code generation"
  - "continue to implementation", "move to code generation", "begin implementation phase"
  - "ready to proceed to the code generation phase" (workflow continuation)

**Do NOT invoke when**:
- Implementation specs don't exist (run `app-builder-implementation-spec` first)
- User wants full implementation logic (Layer 3 generates stubs only)
- Target language is not Python

## The 9-Phase Workflow

This skill follows a **sequential code generation workflow** with validation gates and completeness documentation (Round 2+).

### Phase Overview

1. **Context Loading** - Load Layer 1, 2, and 2.5 entities via Wavesmith
2. **Project Scaffolding** - Create directory structure, venv, configuration
3. **Type Generation** - Generate Pydantic models from schema
4. **Function Stub Generation** - Generate type-safe function stubs (NotImplementedError)
5. **Test Generation** - Generate pytest test scaffolding (RED phase)
6. **Integration & Validation** - Validate syntax, types, test collection
7. **Gap Analysis** (NEW - Round 2) - Identify requirement/schema/code gaps
8. **Completeness Documentation** (NEW - Round 2) - Generate TODO.md, ADRs, README updates
9. **Final Presentation** (Updated - Round 2) - Present summary with documentation

**Round 2 Enhancement**: Phases 7-9 transform "silent incompleteness" into explicit gap documentation with implementation guidance.

## Core Workflow

### Phase 1: Context Loading

Load all inputs from Layers 1, 2, and 2.5 via Wavesmith MCP.

**Load schemas and session**:
```javascript
// 1. Load AppBuilderProject schema (core - no workspace)
await wavesmith.schema_load("app-builder-project");

// 2. Get project by workspace
const workspace_path = process.cwd();
const projects = await wavesmith.store_list("AppBuilderProject", {
  filter: { workspacePath: workspace_path }
});
const project = projects[0];

// 3. Construct workspace paths from project
// Use path.join for proper path construction
const workspace_root = project.workspacePath;
const discovery_dir = path.join(workspace_root, project.discoveryDir);
const schema_dir = path.join(workspace_root, project.schemaDir);
const spec_dir = path.join(workspace_root, project.specDir);
const output_dir = path.join(process.cwd(), project.generatedDir);

// 4. Load implementation-spec schema (core - no workspace)
await wavesmith.schema_load("app-builder-implementation-spec");

// 5. Get implementation session WITH workspace
const session = await wavesmith.store_get("ImplementationSession", sessionId, {
  workspace: spec_dir
});

// 6. Verify complete
if (session.currentPhase !== 'complete') {
  throw Error(`Session not complete (phase: ${session.currentPhase})`);
}

// 7. Load domain schema WITH workspace
await wavesmith.schema_load(session.appSchemaName, {
  workspace: schema_dir
});
```

**Load modules, interfaces, tests**:
```javascript
// Load all modules WITH workspace
const modules = [];
for (const modId of session.modules) {
  const mod = await wavesmith.store_get("ModuleSpecification", modId, {
    workspace: spec_dir
  });
  modules.push(mod);
}

// Load interfaces and tests per module WITH workspace
for (const module of modules) {
  const interfaces = await wavesmith.store_list("InterfaceContract", {
    filter: { module: module.id }
  }, {
    workspace: spec_dir
  });
  module.interfaceEntities = interfaces.data;

  const tests = await wavesmith.store_list("TestSpecification", {
    filter: { module: module.id }
  }, {
    workspace: spec_dir
  });
  module.testEntities = tests.data;
}
```

**Validate schema references**: Ensure all `InterfaceContract.outputs.schemaReference` entities exist in schema.

### Phase 2: Project Scaffolding

Use `scripts/init_project.py` to create the base project structure.

**IMPORTANT**: Generated code goes to `project.generatedDir` (computed as `output_dir` in Getting Started).
Schema files are read from `schema_dir` workspace.

```bash
python scripts/init_project.py \
  --session-name {session.name} \
  --schema-path {schema_dir}/{session.appSchemaName}/schema.json \
  --workspace {output_dir} \
  --extra-libs {domain_specific_libraries}
```

**Example** for contract-template-updater:
```bash
# {skill_path} = .claude/skills/app-builder-implementation-code-generator
python {skill_path}/scripts/init_project.py \
  --session-name contract-template-updater \
  --schema-path {schema_dir}/contract-template-updater/schema.json \
  --workspace {output_dir} \
  --extra-libs "python-docx lxml defusedxml"
```

**Creates** in `output_dir`:
- Directory structure: `src/modules/`, `tests/`, `scripts/`, `generated/`
- Virtual environment: `.venv/`
- Requirements: `requirements.txt`
- Configuration: `.gitignore`, `README.md`

**Copy resources**:
- `assets/build_types.py` → `{output_dir}/scripts/build_types.py`
- `{schema_dir}/{session.appSchemaName}/schema.json` → `{output_dir}/schema.json` (copy for reference)

### Phase 3: Type Generation

Generate Pydantic v2 models from schema:

```bash
cd {output_dir}
.venv/bin/python scripts/build_types.py
```

**Output**: `{output_dir}/generated/models.py` with type-safe Pydantic models for all schema entities.

**Validate**:
```bash
cd {output_dir}
.venv/bin/python -m ast generated/models.py  # Syntax
.venv/bin/mypy generated/models.py            # Types
```

### Phase 4: Function Stub Generation

Generate function stubs from InterfaceContract specifications.

**Workspace Organization**:
- ✅ Use project output directory for temporary files (e.g., `{output_dir}/tmp/`, `{output_dir}/scripts/`)
- ❌ Do NOT write to `/tmp` or other external system locations
- All generated artifacts remain within `output_dir` (project.generatedDir)

---

**Data Materialization**:

Use Wavesmith's `view_project` tool to materialize entity data to temporary JSON files WITH workspace:
- Executes a view query and writes results directly to disk
- Reads from project-specific workspace (spec_dir)
- Avoids manual serialization loops
- Example: `view_project(schema="app-builder-implementation-spec", view="module_interfaces_json", params={moduleId: "mod-001"}, workspace=spec_dir, output_path="{output_dir}/tmp/mod-001-interfaces.json")`

---

**Workflow**:

For each ModuleSpecification, use `view_project` to materialize InterfaceContract data:

1. Use `view_project` to query interfaces and write to JSON file
2. Invoke stub generator script with the materialized data

**Generate stubs**:
```bash
.venv/bin/python scripts/generate_stubs.py \
  --interfaces tmp/${module.id}-interfaces.json \
  --schema-name ${session.appSchemaName} \
  --module-name ${module.name} \
  --output src/modules/${module_name}/${module_file}.py \
  --req-ids ${requirement_ids}
```

**See**: `scripts/generate_stubs.py --help` for full options

---

**Stub Generator Output**:

**Generates**:
- Function signatures with type hints
- Google-style docstrings (purpose + algorithm strategy)
- `NotImplementedError` bodies (safety-critical)
- Traceability comments: `# Implements req-XXX`

**Example output**:
```python
# Implements req-001
def parse_template(template_path: str, extract_custom_xml: bool = True) -> Template:
    """
    Parse a DOCX template file and extract structure.

    Algorithm:
        Unzip DOCX to access document.xml. Parse using python-docx. Extract PW
        section markers by matching paragraph styles.

    Args:
        template_path: Absolute path to DOCX template file
        extract_custom_xml: Whether to extract custom XML metadata

    Returns:
        Parsed template with sections and metadata

    Raises:
        FileNotFoundError: Template file does not exist
        InvalidDOCXError: File is not valid DOCX format
    """
    raise NotImplementedError('parse_template not yet implemented')
```

### Phase 5: Test Generation

Generate pytest test scaffolding from TestSpecification entities.

**Workflow**:

For each ModuleSpecification, use `view_project` to materialize TestSpecification data:

1. Use `view_project` to query tests and write to JSON file
2. Invoke test generator script with the materialized data

**Generate tests**:
```bash
.venv/bin/python scripts/generate_tests.py \
  --tests tmp/${module.id}-tests.json \
  --module-name ${module.name} \
  --output tests/test_${module_name}.py \
  --imports "from src.modules.${module_name} import ..."
```

---

**Test Generator Output**:

**Generates**:
- pytest test functions from TestSpecifications
- Given/When/Then → setup/action/assert comments
- Placeholder assertions (RED phase)
- Traceability docstrings: `Validates: req-XXX`

**Example output**:
```python
def test_req_001_parse_valid_docx_template():
    """Parse valid DOCX template

    Validates: req-001
    Acceptance Criteria: Correctly identifies all PW section markers
    """
    # Given: Setup
    # - A DOCX template file exists with multiple PW section markers

    # When: Action
    # parse_template is called with the template path
    # TODO: Implement function call
    # result = parse_template(...)

    # Then: Assertions
    # - All PW section markers are identified and extracted
    # TODO: assert ...

    # Placeholder: Remove when implementing test
    assert False, 'Test not yet implemented'
```

### Phase 6: Integration & Validation

**Run validation suite**:
```bash
# Syntax (all .py files)
for file in $(find src/ tests/ -name "*.py"); do
  .venv/bin/python -m ast $file || exit 1
done

# Type checking
.venv/bin/mypy src/ --strict

# Test collection
.venv/bin/pytest --collect-only tests/

# RED phase validation
.venv/bin/pytest tests/
# Expected: All tests fail with NotImplementedError
```

**Generate artifacts**:
- Traceability report: Requirements → Modules → Functions → Tests
- Gap coverage report: Requirements → Code status (from Phase 7)

**Next phase**: Phase 7 (Gap Analysis) for completeness documentation.

### Phase 7: Gap Analysis (NEW - Round 2)

Identify features in requirements/schema but not in generated code.

**Purpose**: Create explicit documentation of what's NOT implemented, replacing silent incompleteness with actionable gap list.

**Load discovery requirements**:
```javascript
// Load discovery schema (core - no workspace)
await wavesmith.schema_load("app-builder-discovery");

// Get discovery session WITH workspace
const implSession = await wavesmith.store_get("ImplementationSession", sessionId, {
  workspace: spec_dir
});
const discoverySession = await wavesmith.store_get("DiscoverySession", implSession.discoverySession, {
  workspace: discovery_dir
});

// Load all requirements WITH workspace
const requirements = [];
for (const reqId of discoverySession.requirements) {
  const req = await wavesmith.store_get("Requirement", reqId, {
    workspace: discovery_dir
  });
  requirements.push(req);
}

console.log(`Loaded ${requirements.length} requirements for gap analysis`);
```

**Load schema entities**:
```javascript
// Parse schema.json from schema workspace
const schemaPath = `${schema_dir}/${session.appSchemaName}/schema.json`;
const schemaContent = fs.readFileSync(schemaPath, 'utf-8');
const schema = JSON.parse(schemaContent);

// Extract entity names from $defs
const entityNames = Object.keys(schema.$defs || {});
console.log(`Found ${entityNames.length} schema entities`);
```

**Scan generated code**:
```bash
# List all function stubs
cd {output_dir}
find src/modules -name "*.py" -exec grep -l "raise NotImplementedError" {} \;

# List all generated models
grep "^class " generated/models.py | awk '{print $2}' | sed 's/(.*$//'

# List all test functions
find tests -name "test_*.py" -exec grep "^def test_" {} \;
```

**Identify gaps**:

1. **Requirement-to-Code Gaps**:
   - Requirements with no corresponding function stub
   - Requirements with function stub but no test case
   - Requirements mentioned in spec but not in generated code

2. **Schema-to-Code Gaps**:
   - Schema entities not represented in generated/models.py
   - Schema fields present in models but never used in function signatures
   - Error states modeled in schema but not handled in code

3. **Test Coverage Gaps**:
   - Functions with no tests
   - Requirements with no validation tests
   - Edge cases specified in acceptance criteria but not tested

**Categorize gaps**:
```javascript
const gaps = {
  P0_critical: [],    // Blocks core functionality
  P1_high: [],        // Important for production
  P2_medium: [],      // Nice to have
  deferred: []        // Explicitly deferred in earlier phases
};

for (const req of requirements) {
  const hasStub = checkIfFunctionStubExists(req);
  const hasTest = checkIfTestExists(req);
  const hasImplementation = !hasStub || checkIfNotImplementedError(req);

  if (!hasStub && !hasTest) {
    gaps.P0_critical.push({
      requirement: req,
      status: 'completely_missing',
      reason: 'No stub or test generated'
    });
  } else if (hasStub && !hasTest) {
    gaps.P1_high.push({
      requirement: req,
      status: 'stub_present_no_test',
      reason: 'Function stub exists but no test case'
    });
  } else if (hasStub && hasTest && hasImplementation) {
    gaps.P2_medium.push({
      requirement: req,
      status: 'stub_present',
      reason: 'Expected - TDD RED phase'
    });
  }
}
```

**Output**: Gap data structure for Phase 8 documentation generation.

**Domain-agnostic patterns**:
- Document Processing: Missing OCR quality validation, gap detection logic
- Data Pipeline: Missing batch retry strategy, anomaly detection
- Web Application: Missing session management, rate limiting
- Automation Workflow: Missing task prioritization, workflow state machine

### Phase 8: Completeness Documentation (NEW - Round 2)

Generate documentation showing what's implemented and what's not.

**Purpose**: Transform gap analysis into three actionable documentation artifacts:
1. TODO.md - Prioritized implementation backlog
2. ARCHITECTURE_DECISIONS.md - Design rationale from earlier phases
3. README.md Known Limitations - Production readiness visibility

---

#### Generate TODO.md

**Template location**: `assets/templates/TODO.md.template`

**Content structure**:
```markdown
# Implementation TODO List

Generated: {timestamp}
Source: Cross-layer gap analysis (Discovery → Schema → Spec → Code)

This file lists features specified in discovery/schema/spec phases but not yet implemented in generated code.

## Critical (P0) - Required for Core Functionality

### {Requirement Title}
**Requirement**: {req-id} "{requirement description}"
**Schema Support**: {entity.field or "NOT MODELED"}
**Spec Support**: {interface or "NOT SPECIFIED"}
**Current Status**: {Stub Present | Completely Missing | Partial}
**Implementation Guidance**:
- {algorithmic guidance from InterfaceContract.algorithmStrategy}
- {schema field usage hints}
- {validation rules from acceptance criteria}
**Test Cases**: {test file}::{test function} ({RED | MISSING})

## High Priority (P1) - Important for Production

{Repeat pattern}

## Medium Priority (P2) - Nice to Have

{Repeat pattern}

## Deferred Items

{Items explicitly deferred in schema/spec phases with rationale}
```

**Generate via script**:
```bash
# {skill_path} = .claude/skills/app-builder-implementation-code-generator
cd ${workspace}
.venv/bin/python {skill_path}/scripts/generate_todo.py \
  --gaps tmp/gap_analysis.json \
  --requirements tmp/requirements.json \
  --interfaces tmp/all_interfaces.json \
  --output TODO.md
```

**Domain-agnostic example entries**:

```markdown
# Document Processing Domain
### Validate Document Completeness
**Requirement**: req-008 "Check all required fields present before processing"
**Schema Support**: ValidationResult entity with rules field
**Spec Support**: validate_completeness() interface (document-validator module)
**Current Status**: Function stub present, NotImplementedError
**Implementation Guidance**:
- Apply validation rules from ValidationResult.rules
- Return pass/fail with specific field errors
- Populate ValidationResult entity with findings
**Test Cases**: tests/test_validator.py::test_validates_required_fields (RED)

# Data Pipeline Domain
### Detect Data Quality Anomalies
**Requirement**: req-012 "Flag anomalous data during ETL"
**Schema Support**: DataQualityScore entity, AnomalyDetection field
**Spec Support**: Models defined, detection logic deferred
**Current Status**: Models generated, no detection implementation
**Implementation Guidance**:
- Implement statistical anomaly detection (z-score or IQR method)
- Populate DataQualityScore.anomalies array
- Consider domain-specific thresholds (require training data)
**Test Cases**: No tests generated (anomaly detection post-code-gen)

# Web Application Domain
### Implement Session State Management
**Requirement**: req-009 "Track user session across requests"
**Schema Support**: Session entity with userId, expiresAt fields
**Spec Support**: create_session(), validate_session() interfaces
**Current Status**: Function stubs present, NotImplementedError
**Implementation Guidance**:
- Use Redis or in-memory store for session data
- Implement TTL expiration (expiresAt field)
- Validate session token on each protected route
**Test Cases**: tests/test_session.py::test_creates_valid_session (RED)
```

---

#### Generate ARCHITECTURE_DECISIONS.md

**Template location**: `assets/templates/ADR.md.template`

**Content structure**:
```markdown
# Architecture Decisions Record

Generated: {timestamp}
Source: Cross-phase design decisions (Schema → Spec → Code)

This file documents key design decisions made during the app-builder pipeline.

## ADR-{number}: {Decision Title}

**Status**: {Accepted | Deferred | Rejected}
**Context**: {Problem or requirement driving decision}
**Decision**: {What was decided}
**Rationale**:
- {Reason 1}
- {Reason 2}
- {Reason 3}
**Consequences**:
- Benefits: {positive outcomes}
- Trade-offs: {negative outcomes or risks}
- Mitigation: {how to address trade-offs if applicable}
**Alternatives Considered**: {If applicable}

---

{Repeat for each decision}
```

**Extract decisions from**:
1. **Implementation Spec Ambiguity Resolutions** (Fix #3):
   - Strategy Resolution Pass decisions → ADRs
   - Extraction approach (code-based vs LLM)
   - Algorithm choices with rationale

2. **Schema Extension Decisions** (Fix #2):
   - Entity vs field choices
   - Gap coverage strategies
   - Deferred features

3. **Code Generation Choices**:
   - Project structure decisions
   - Library selections
   - Type system choices

**Generate via script**:
```bash
# {skill_path} = .claude/skills/app-builder-implementation-code-generator
cd ${workspace}
.venv/bin/python {skill_path}/scripts/generate_adrs.py \
  --impl-session tmp/impl_session.json \
  --interfaces tmp/all_interfaces.json \
  --output ARCHITECTURE_DECISIONS.md
```

**Domain-agnostic decision patterns**:

```markdown
# Pattern 1: Processing Approach Decision
## ADR-001: Code-Based {Processing Type} (No LLM)

**Status**: Accepted
**Context**: Discovery requirements included {complex feature} with {specific patterns}. Implementation spec resolved ambiguity toward pure code approach.
**Decision**: Use {language} {approach} (regex, heuristics, library) rather than LLM-assisted {processing}.
**Rationale**:
- Implementation spec had no LLM interfaces (Fix #3 strategy resolution)
- Discovery requirements emphasize cost constraints ({cost target})
- Pattern-based {processing} appears sufficient for {structured data type}
**Consequences**:
- Benefits: Lower operational cost, faster execution, offline capability
- Trade-offs: May not reach {quality target} if {data} formats highly variable
- Mitigation: Log unhandled cases, iterate on patterns

# Pattern 2: Gap Deferral Decision
## ADR-002: {Feature} Deferred to Manual Implementation

**Status**: Deferred
**Context**: Schema includes {entity/field}, spec includes {interface}, but implementation requires {specific knowledge}.
**Decision**: Generate function stub but leave implementation to GREEN phase.
**Rationale**:
- {Feature} requires {domain-specific} understanding
- Pattern varies by {application-specific factor}
- Implementation requires test case refinement with real data
**Consequences**:
- Benefits: Core {functionality} works, extensible architecture
- Trade-offs: {Feature validation/verification} requires manual work
- Post-MVP addition needed for production readiness

# Pattern 3: Partial Implementation Decision
## ADR-003: {Feature} Models Only

**Status**: Partial
**Context**: Schema includes {entities} for {workflow/feature}, but orchestration logic is application-specific.
**Decision**: Generate data models but no workflow/UI implementation.
**Rationale**:
- {Feature} requires UI/API design beyond code generation scope
- State tracking modeled, orchestration is application-specific
- Enables future implementation without schema changes
**Consequences**:
- Benefits: Database schema supports {feature}, future-proof data model
- Trade-offs: Application logic must be added post-generation
- {Feature} requires additional development effort (see TODO.md)
```

**Example instantiations**:

```markdown
# Document Processing Example
## ADR-001: Code-Based Extraction (No LLM)

**Status**: Accepted
**Context**: German procurement PDFs with "wie zuvor" inheritance patterns. Implementation spec resolved extraction method ambiguity toward regex-based parsing.
**Decision**: Pure Python parsing with regex patterns for position extraction and inheritance resolution.
**Rationale**:
- Implementation spec documented specific regex patterns (Fix #3)
- Discovery requirements emphasize cost target ($10/document max)
- Structured technical documents have predictable formats
**Consequences**:
- Benefits: Low cost (~$0.10/document), fast processing, offline
- Trade-offs: May not reach 0.90 confidence if PDF formats highly variable
- Mitigation: Log unparseable patterns, iterate regex

# Data Pipeline Example
## ADR-001: SQL-Based Transformation (No Pandas)

**Status**: Accepted
**Context**: Large-scale ETL with complex joins (millions of records). Implementation spec selected SQL over in-memory approach.
**Decision**: SQL transformations in database, no pandas DataFrames.
**Rationale**:
- Performance target: Process 1M records/hour
- Database supports complex joins natively
- Avoid memory constraints of in-memory processing
**Consequences**:
- Benefits: Scalability, leverages database optimization
- Trade-offs: Less flexible than pandas, SQL dialect lock-in
- Mitigation: Use SQLAlchemy for database abstraction

# Web Application Example
## ADR-002: Session Management Deferred

**Status**: Deferred
**Context**: Schema includes Session entity with userId, expiresAt fields. Spec includes create/validate interfaces but no storage strategy defined.
**Decision**: Generate session models and interface stubs, defer storage implementation.
**Rationale**:
- Storage choice (Redis, DB, in-memory) depends on deployment environment
- TTL strategy varies by application security requirements
- Requires infrastructure decisions beyond code generation
**Consequences**:
- Benefits: Flexible storage strategy, application-specific tuning
- Trade-offs: Session management requires manual implementation
- See TODO.md P1: Implement session storage adapter
```

---

#### Update README.md Known Limitations Section

**Template location**: `assets/templates/README_known_limitations.md.template`

**Insert after "TDD Workflow" section** in README.md:

```markdown
## Known Limitations

This generated code is a **TDD-ready implementation** with function stubs. It provides:
- ✅ Complete data models (Pydantic classes)
- ✅ Type-safe interfaces (with NotImplementedError stubs)
- ✅ Comprehensive test suite (RED phase)
- ✅ Algorithm pseudocode (in docstrings)

**What's NOT implemented** (see TODO.md for details):
- ❌ {Gap 1 title} (P0 - critical)
- ❌ {Gap 2 title} (P1 - high priority)
- ❌ {Gap 3 title} (P1 - high priority)
- ❌ {Gap 4 title} (P2 - nice to have)

**Production Readiness**: ~{percentage}%
- {Module category 1}: {percentage}% ({reason})
- {Module category 2}: {percentage}% ({reason})
- {Module category 3}: {percentage}% ({reason})

**Calculation**: Production readiness = (implemented_requirements / total_requirements) × 100

**Next Steps**:
1. Review TODO.md for implementation priorities
2. Review ARCHITECTURE_DECISIONS.md for design context
3. Implement function stubs (GREEN phase) starting with P0 items
4. Add {deferred feature} (see TODO.md Deferred Items)
5. Production hardening (error handling, logging, monitoring)
```

**Production readiness examples**:

```markdown
# Document Processing Example
**Production Readiness**: ~65%
- Core extraction: 70% (position parsing yes, gap detection no)
- Validation: 60% (confidence calculation yes, completeness check no)
- Error handling: 50% (basic errors yes, edge cases no)

Calculation:
- Core requirements: 8/10 have stubs (80%)
- Validation requirements: 3/6 have implementations (50%)
- Error requirements: 4/8 have implementations (50%)
- Weighted average: 0.5×80% + 0.3×50% + 0.2×50% = 65%

# Data Pipeline Example
**Production Readiness**: ~70%
- Core ETL: 80% (extract/transform yes, complex joins no)
- Data quality: 60% (basic validation yes, anomaly detection no)
- Error handling: 70% (retry logic yes, dead letter queue no)

Calculation:
- Core requirements: 12/15 have implementations (80%)
- Quality requirements: 6/10 have implementations (60%)
- Error requirements: 7/10 have implementations (70%)
- Weighted average: 0.6×80% + 0.25×60% + 0.15×70% = 70.5%

# API Gateway Example
**Production Readiness**: ~75%
- Request routing: 90% (basic routes yes, complex rules no)
- Auth/authz: 70% (authentication yes, fine-grained permissions no)
- Rate limiting: 60% (simple limits yes, quota management no)

Calculation:
- Routing requirements: 9/10 have implementations (90%)
- Auth requirements: 7/10 have implementations (70%)
- Rate limit requirements: 3/5 have implementations (60%)
- Weighted average: 0.4×90% + 0.4×70% + 0.2×60% = 76%
```

**Generate via script**:
```bash
# {skill_path} = .claude/skills/app-builder-implementation-code-generator
cd ${workspace}
.venv/bin/python {skill_path}/scripts/update_readme.py \
  --readme README.md \
  --gaps tmp/gap_analysis.json \
  --requirements tmp/requirements.json \
  --insert-after "TDD Workflow"
```

---

**Validation gates**:

After documentation generation:
- ✅ Verify TODO.md has at least 1 item (unless 100% coverage, unlikely)
- ✅ Verify ADRs reference actual spec/schema decisions (not hallucinated)
- ✅ Verify README Known Limitations matches TODO.md P0/P1 gaps
- ⚠️ Warning if >50% requirements have no code representation
- ❌ Error if critical (P0) requirements completely missing stub/test

**Phase 8 output**:
- `TODO.md` with prioritized gap list
- `ARCHITECTURE_DECISIONS.md` with design rationale
- `README.md` updated with Known Limitations section

### Phase 9: Final Presentation (Updated - Round 2)

Present comprehensive summary with generated code, validation results, and completeness documentation.

**Generate final README updates**:
- Module overview section
- TDD workflow instructions
- Known Limitations section (from Phase 8)
- Validation results summary

**Present summary to user**:
```
✅ Code Generation Complete

Generated:
- {module_count} modules with {function_count} function stubs
- {test_count} test cases (RED phase)
- {model_count} Pydantic models

Validation:
- ✅ Syntax validation passed
- ✅ Type checking passed (mypy --strict)
- ✅ Test collection passed ({test_count} tests discovered)
- ✅ RED phase confirmed (all tests fail with NotImplementedError)

Documentation:
- ✅ TODO.md: {gap_count} items ({p0_count} critical, {p1_count} high priority)
- ✅ ARCHITECTURE_DECISIONS.md: {adr_count} design decisions documented
- ✅ README.md: Known Limitations section added

Production Readiness: ~{readiness_pct}%

Next Steps:
1. Review TODO.md for implementation priorities
2. Review ARCHITECTURE_DECISIONS.md for design context
3. Activate virtual environment: cd {workspace} && source .venv/bin/activate
4. Run tests to verify RED phase: pytest tests/
5. Implement function stubs (GREEN phase) starting with P0 items
6. Re-run tests after each implementation to reach GREEN phase
7. Address TODO.md items systematically
```

**User engagement**:
- Show example P0 gap from TODO.md
- Show example ADR from ARCHITECTURE_DECISIONS.md
- Emphasize production readiness percentage and what it means
- Provide clear path forward: TODO.md is the implementation roadmap

## Safety-Critical Requirements

**Session 1 Baseline: Stubs Only**

1. **Function Bodies**: MUST contain ONLY `raise NotImplementedError(...)`
2. **No Executable Logic**: Never generate actual implementations
3. **Algorithm Strategies**: In docstrings only, not code
4. **No Code Execution**: Use ast.parse for validation, not import/exec
5. **Schema Validation**: Validate all entity references BEFORE generation

**See**: `references/safety-guidelines.md` for complete safety protocols.

## Success Criteria

**Baseline Target (Session 1)**: ≤5 interventions

**Quality Gates**:
- All modules scaffolded (100%)
- All function stubs generated (100%)
- All tests generated (100%)
- Syntax validation passes
- Type checking passes (mypy --strict)
- Test collection passes
- RED phase confirmed (all tests fail with NotImplementedError)
- Zero executable logic in function bodies
- 100% cross-layer traceability maintained

## Example: Contract-Template-Updater

**Input**: impl-sess-001 (Layer 2.5)
- 5 modules, 6 interfaces, 24 test specs

**Output**: Python project at `.schemas/contract-template-updater/`
```
{project_root}/
└── .schemas/
    └── contract-template-updater/    # Workspace (bridge skill created this)
        ├── schema.json               # Already exists from bridge skill
        ├── .venv/                    # Created by init_project.py
        ├── scripts/
        │   └── build_types.py        # Copied from assets
        ├── generated/
        │   └── models.py             # Template, Contract, Section types
        ├── src/modules/
        │   ├── document_parser/
        │   │   └── parser.py         # parse_template, parse_contract stubs
        │   ├── comparison_engine/
        │   │   └── comparator.py     # compare_templates stub
        │   └── ...
        ├── tests/
        │   ├── test_document_parser.py    # 3 tests
        │   ├── test_comparison_engine.py  # 5 tests
        │   └── ...
        ├── requirements.txt
        ├── .gitignore
        └── README.md
```

**Key Pattern**: Implementation happens in the same directory where bridge skill created the schema.
This maintains tight coupling - if schema updates, build_types.py regenerates models, type errors guide implementation updates.

**Validation**: ✅ 5/5 modules, 6/6 stubs, 24/24 tests, all fail with NotImplementedError

## Bundled Resources

### scripts/
Executable Python scripts for code generation:

- **`init_project.py`** - Project scaffolding orchestrator
  - Creates directory structure, venv, configuration files
  - Usage: `python scripts/init_project.py --session-name X --schema-path Y --workspace Z`

- **`generate_stubs.py`** - InterfaceContract → function stub transformer
  - Generates type-safe stubs with NotImplementedError bodies
  - Usage: `python scripts/generate_stubs.py --interfaces X.json --schema-name Y --output Z.py`

- **`generate_tests.py`** - TestSpecification → pytest test transformer
  - Generates pytest functions with Given/When/Then structure
  - Usage: `python scripts/generate_tests.py --tests X.json --module-name Y --output Z.py`

- **`generate_todo.py`** (NEW - Round 2) - Gap analysis → TODO.md transformer
  - Generates prioritized implementation backlog from gap analysis
  - Usage: `python scripts/generate_todo.py --gaps X.json --requirements Y.json --output TODO.md`

- **`generate_adrs.py`** (NEW - Round 2) - Design decisions → ADR transformer
  - Extracts architecture decisions from spec resolutions and generates ADR document
  - Usage: `python scripts/generate_adrs.py --impl-session X.json --interfaces Y.json --output ARCHITECTURE_DECISIONS.md`

- **`update_readme.py`** (NEW - Round 2) - Gap analysis → README Known Limitations transformer
  - Inserts Known Limitations section into README with production readiness estimate
  - Usage: `python scripts/update_readme.py --readme README.md --gaps X.json --insert-after "TDD Workflow"`

### references/
Documentation loaded as needed during code generation:

- **`architectural-context.md`** - Layer positioning, cross-layer references, pure projection pattern
- **`transformation-patterns.md`** - 5 core transformation patterns with detailed examples
- **`project-structure.md`** - Expected directory layout, naming conventions, best practices
- **`safety-guidelines.md`** - Safety-critical requirements, validation strategy, TDD philosophy
- **`wavesmith-integration.md`** - MCP tool usage patterns, entity operations, error handling
- **`gap-analysis-patterns.md`** (NEW - Round 2) - Gap identification algorithms, categorization criteria, production readiness formulas

### assets/
Files used in generated project output:

- **`build_types.py`** - Schema → Pydantic generator (from kpmg-contract-parser pattern)
  - Runs datamodel-codegen, adds headers, creates __init__.py
  - Copied to generated project's `scripts/build_types.py`

- **`gitignore.template`** - Python .gitignore template
- **`requirements.txt.template`** - Base dependencies template

### assets/templates/ (NEW - Round 2)
Nunjucks templates for completeness documentation:

- **`TODO.md.template`** - Implementation backlog template with prioritized gaps
- **`ADR.md.template`** - Architecture Decision Record template
- **`README_known_limitations.md.template`** - Known Limitations section template for README

## Error Handling

**Schema not found**:
```
❌ Schema 'contract-template-updater' not found
Available schemas: app-builder-discovery, app-builder-implementation-spec, ...
Run app-builder-schema-designer to create it.
```

**Session not complete**:
```
❌ Implementation session 'contract-template-updater' not complete
Current phase: module-design
Run app-builder-implementation-spec to finish.
```

**Validation failures**:
```
❌ Syntax validation failed:
  src/modules/parser/parser.py:42 - invalid syntax
Fix syntax errors before proceeding.
```

## Notes

- **Session 1**: Stubs + tests only (safest baseline)
- **Session 2+**: Full test implementations, targeted simple patterns (if validated)
- **Never**: Generate complex business logic or security-sensitive code

This skill provides **safe scaffolding**, not **intelligent implementation**. Trust the TDD process - developers implement the GREEN phase manually.
