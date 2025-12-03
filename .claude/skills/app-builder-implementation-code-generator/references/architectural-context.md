# Architectural Context: Layer 3 Code Generation

## Layer Positioning in App-Builder Pipeline

The implementation code generator (Layer 3) is the final transformation layer in the conversational app-building system:

```
User Problem Statement
    ↓
Layer 1: Discovery (app-builder-discovery)
    ├─ Output: DiscoverySession, Requirements[], SolutionProposal
    ├─ Purpose: Problem → Requirements
    └─ Status: Validated (0 interventions)
    ↓
Layer 2: Schema Designer (app-builder-schema-designer)
    ├─ Input: Requirements, Analysis from Layer 1
    ├─ Output: Enhanced JSON Schema (domain model)
    ├─ Purpose: Requirements → Domain Entities
    └─ Status: Validated (0 interventions)
    ↓
Layer 2.5: Implementation Spec (app-builder-implementation-spec)
    ├─ Input: Requirements (L1), Schema (L2)
    ├─ Output: ModuleSpecification[], InterfaceContract[], TestSpecification[]
    ├─ Purpose: Schema → Implementation Plan
    └─ Status: Validated (Session 1: 0 friction)
    ↓
Layer 3: Code Generator [THIS LAYER]
    ├─ Input: ImplementationSession (L2.5), Application Schema (L2)
    ├─ Output: Executable Python code (stubs + tests)
    ├─ Purpose: Specs → Type-Safe Code
    └─ Status: Design Ready
    ↓
Working Application
```

## Cross-Layer Data Flow

### Layer 3 Consumes From All Previous Layers

#### From Layer 1 (Discovery)
- **DiscoverySession**: Project context, problem understanding
- **Requirement[]**: Acceptance criteria for test generation
- **SolutionProposal**: Architecture phases (map to modules)

**Usage**: Traceability comments in generated code, README context

#### From Layer 2 (Schema Designer)
- **Enhanced JSON Schema**: Domain entity definitions
- **Entity Types**: Template, Section, Contract, etc.

**Usage**: Generate Pydantic models, type hints in function stubs

#### From Layer 2.5 (Implementation Spec)
- **ImplementationSession**: Root orchestrator
- **ModuleSpecification[]**: 5-6 modules per project
- **InterfaceContract[]**: 6+ function signatures
- **TestSpecification[]**: 24+ test scenarios

**Usage**: Primary input - transformed into code

## Cross-Layer Reference Resolution

### Schema Entity References

InterfaceContracts reference Layer 2 schema entities:

```json
{
  "id": "iface-001",
  "functionName": "parseTemplate",
  "outputs": {
    "type": "Template",
    "schemaReference": "contract-template-updater.Template"
  }
}
```

**Resolution Process**:
1. Load schema: `wavesmith.schema_load('contract-template-updater')`
2. Validate entity exists: Check `Template` in `schema.$defs`
3. Generate Pydantic model: Run `build_types.py`
4. Generate type hint: `-> Template` (imports from `generated.models`)

**Failure Mode**: If entity doesn't exist, fail fast with clear error before code generation.

### Requirement Traceability

TestSpecifications link to Layer 1 Requirements:

```json
{
  "id": "test-001",
  "scenario": "Parse valid DOCX template",
  "validatesRequirement": "req-001",
  "validatesAcceptanceCriteria": "Correctly identifies all PW section markers"
}
```

**Traceability in Generated Code**:
```python
def test_parse_valid_docx_template():
    """Parse valid DOCX template

    Validates: req-001
    Acceptance Criteria: Correctly identifies all PW section markers
    """
    ...
```

**Query Pattern**:
```bash
# Which tests validate req-001?
grep -r "req-001" tests/

# Which function implements req-003?
grep -r "req-003" src/
```

## Entity Relationships

### Layer 3 Entities

```
CodeGenerationSession (root)
    ├─ references: ImplementationSession (Layer 2.5)
    ├─ references: applicationSchema (name, Layer 2)
    ├─ config: { targetLanguage, generationStrategy, workspacePath }
    └─ modules: [ModuleImplementation]

ModuleImplementation
    ├─ references: ModuleSpecification (Layer 2.5)
    ├─ code: { filePath, content (opaque) }
    └─ functions: [FunctionImplementation]

FunctionImplementation
    ├─ references: InterfaceContract (Layer 2.5)
    └─ code: { signature, docstring, body (opaque) }

TestImplementation
    ├─ references: TestSpecification (Layer 2.5)
    └─ code: { testFunction, assertions (opaque) }
```

### Cross-Layer Traceability Chain

```
Requirement (L1)
    → ModuleSpecification (L2.5, implementsRequirements[])
    → ModuleImplementation (L3, references moduleSpec)
    → FunctionImplementation (L3)
    → TestImplementation (L3, validatesRequirement)
```

**Query via Wavesmith**:
```javascript
// Which function implements req-001?
store_list('FunctionImplementation', {
  filter: { /* module that implements req-001 */ }
})

// Which tests validate module-X?
store_list('TestImplementation', {
  filter: { module: 'module-X-id' }
})
```

## Workspace Organization

### Layer 2.5 Workspace (Input)

```
.schemas/app-builder-implementation-spec/workspaces/contract-template-updater/
├── overview.md              # Implementation session summary
├── modules/                 # ModuleSpecification outputs
│   └── specifications.yaml
├── interfaces/              # InterfaceContract outputs
│   └── contracts.yaml
└── tests/                   # TestSpecification outputs
    └── scenarios.md
```

### Layer 3 Workspace (Output)

```
.schemas/app-builder-implementation-code-generator/workspaces/contract-template-updater/
├── schema.json              # Copied from Layer 2
├── scripts/
│   └── build_types.py       # Schema → Pydantic generator
├── generated/
│   ├── __init__.py
│   └── models.py            # Auto-generated types
├── src/
│   └── modules/
│       ├── document_parser/
│       │   ├── __init__.py
│       │   └── parser.py    # Function stubs
│       └── comparison_engine/
│           ├── __init__.py
│           └── comparator.py
├── tests/
│   ├── test_document_parser.py
│   └── test_comparison_engine.py
├── requirements.txt
├── .gitignore
├── .venv/
└── README.md
```

## Pure Projection Pattern

**Critical Principle**: Layer 3 is a PURE PROJECTION of Layer 2.5 - it never invents content.

### Evidence-Based Transformation Rules

1. **Function Names**: From `InterfaceContract.functionName` (camelCase → snake_case)
2. **Function Signatures**: From `InterfaceContract.inputs` (parameters) + `outputs` (return type)
3. **Docstrings**: From `InterfaceContract.purpose` + `algorithmStrategy`
4. **Type Hints**: From `InterfaceContract.outputs.schemaReference` (validated against Layer 2)
5. **Test Names**: From `TestSpecification.scenario` (sanitized to snake_case)
6. **Test Logic**: From `TestSpecification.given/when/then` (transformed to setup/action/assert)
7. **Module Structure**: From `ModuleSpecification.name` (one module per spec)

### What is NOT Allowed

- ❌ Hallucinated function names not in InterfaceContracts
- ❌ Invented test scenarios not in TestSpecifications
- ❌ Guessed algorithm implementations (only NotImplementedError)
- ❌ Assumed schema entity types (must validate)
- ❌ Creative module organization (follow ModuleSpecifications exactly)

## Schema-Driven Type Safety

### The build_types.py Pattern

Proven pattern from kpmg-contract-parser:

```python
# 1. Load Layer 2 schema
schema = json.load(open('schema.json'))

# 2. Generate Pydantic models via datamodel-codegen
subprocess.run([
    'datamodel-codegen',
    '--input', 'schema.json',
    '--output', 'generated/models.py',
    '--output-model-type', 'pydantic_v2.BaseModel',
    '--field-constraints',
    '--snake-case-field'
])

# 3. Add header with schema hash
header = f'# Generated from schema.json (hash: {schema_hash})'
prepend_to_file('generated/models.py', header)

# 4. Create __init__.py
create_init('generated/', export_all_models=True)
```

### Type Safety Cascade

```
Layer 2 schema.json (SOURCE OF TRUTH)
    ↓ build_types.py
generated/models.py (Pydantic v2)
    ↓ import
src/modules/parser.py (Function stubs with type hints)
    ↓ mypy validation
Type errors surface immediately if schema changed
```

### Drift Detection

When schema evolves:

1. Edit `schema.json` (or regenerate from Layer 2)
2. Run: `python scripts/build_types.py`
3. Run: `mypy src/`
4. **Type errors show drift** - implementation must update

Example:
```
# Before: schema had 'totalSections' field
def parse_template() -> Template:
    return Template(total_sections=len(sections))

# After: schema renamed to 'sectionCount'
# mypy error: Template() got unexpected keyword argument 'total_sections'

# Fix by updating code:
def parse_template() -> Template:
    return Template(section_count=len(sections))  # ✅
```

## Domain Adaptation

### Opaque Fields for Extensibility

Layer 3 adapts to any domain via opaque fields from Layer 2.5:

**ModuleSpecification.details** (opaque object):
```json
{
  "algorithm": "DOCX parsing",
  "libraries": ["python-docx", "lxml"],
  "pwMarkerPattern": "<<.*?>>"
}
```

**Usage**: Extract `libraries` → `requirements.txt`

**InterfaceContract.inputs/outputs** (opaque objects):
```json
{
  "inputs": {
    "template_path": { "type": "string", "required": true },
    "extract_metadata": { "type": "boolean", "default": true }
  }
}
```

**Usage**: Generate function parameters with defaults

### Language/Framework Support

**Session 1 Baseline**: Python only
**Future Sessions**: TypeScript, Rust, Go

**Extensibility Point**: `CodeGenerationSession.config.targetLanguage`

```json
{
  "targetLanguage": "python",
  "generationStrategy": "stubs-only",
  "targetFramework": null  // Future: "fastapi", "flask", "django"
}
```

**Language-Specific Patterns**:
- **Python**: snake_case, type hints, pytest, mypy
- **TypeScript**: camelCase, interfaces, Jest, tsc
- **Rust**: snake_case, Result<T,E>, cargo test

## Evolution Philosophy

### Why Stubs-Only for Session 1?

**Safety-Critical**: LLM-generated executable logic is HIGH RISK.

**Mitigation Strategy**:
1. **Session 1**: Stubs only (`NotImplementedError` bodies) ← SAFEST
2. **Session 2**: TDD skeletons (stubs + full test implementations)
3. **Session 3+**: Targeted implementation (simple patterns only, if validated)

**Rationale**: Prove the SAFE baseline (stubs + tests) before attempting risky code generation.

### Future: Full Implementation

**IF Session 1-3 validate successfully** (0 interventions, quality gates pass):

**Potential Session 4+**: Generate simple implementations from `algorithmStrategy`:

```python
# InterfaceContract.algorithmStrategy:
# "Read file at path, parse with json.load, return as dict"

# Generated implementation:
def load_json(file_path: str) -> dict:
    """Load JSON file and return parsed dictionary."""
    with open(file_path, 'r') as f:
        return json.load(f)
```

**Requirements for Full Implementation**:
- Session 1-3 evidence shows 100% reliability
- Clear safety boundaries (no eval/exec, no shell injection vectors)
- Algorithm strategies are prescriptive, not vague
- Validation includes execution tests (not just syntax)
- Human review required before use

**Never Attempt**:
- Complex business logic
- Security-sensitive operations
- Performance-critical algorithms
- Domain-specific heuristics

Layer 3 is about **scaffolding**, not **intelligence**. Keep it deterministic, safe, and evidence-based.
