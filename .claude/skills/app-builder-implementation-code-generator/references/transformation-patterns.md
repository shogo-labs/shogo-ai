# Transformation Patterns: Layer 2.5 → Layer 3 Code

This document defines the **exact transformations** from implementation specifications to executable code. These patterns are deterministic, evidence-based, and never inventive.

---

## Pattern 1: InterfaceContract → Python Function Stub

### Input: InterfaceContract (JSON)

```json
{
  "id": "iface-001",
  "module": "mod-001",
  "functionName": "parseTemplate",
  "purpose": "Parse a DOCX template file and extract structure",
  "inputs": {
    "template_path": {
      "type": "string",
      "description": "Absolute path to DOCX template file",
      "required": true
    },
    "extract_custom_xml": {
      "type": "boolean",
      "description": "Whether to extract custom XML metadata",
      "default": true
    }
  },
  "outputs": {
    "type": "Template",
    "schemaReference": "contract-template-updater.Template",
    "description": "Parsed template with sections and metadata"
  },
  "errors": {
    "FileNotFoundError": {
      "when": "Template file does not exist at specified path"
    },
    "InvalidDOCXError": {
      "when": "File is not a valid DOCX format"
    }
  },
  "algorithmStrategy": "Unzip DOCX to access document.xml. Parse using python-docx. Extract PW section markers by matching paragraph styles."
}
```

### Output: Python Function Stub

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
        FileNotFoundError: Template file does not exist at specified path
        InvalidDOCXError: File is not a valid DOCX format
    """
    raise NotImplementedError('parse_template not yet implemented')
```

### Transformation Rules

#### 1. Function Name
```
Input:  functionName (camelCase)
Output: snake_case equivalent

Examples:
  parseTemplate       → parse_template
  compareTemplates    → compare_templates
  generateWithTrackChanges → generate_with_track_changes
```

#### 2. Function Signature

**Parameters** (from `inputs`):
```python
# For each key in inputs:
param_name: type_hint = default_value  # if default exists

# Type mapping (JSON Schema → Python):
"string"  → str
"number"  → float
"integer" → int
"boolean" → bool
"array"   → list
"object"  → dict
```

**Return Type** (from `outputs`):
```python
# If schemaReference exists:
→ EntityType  # from schemaReference (e.g., "schema.Template" → Template)

# Otherwise, from outputs.type:
"string"  → str
"object"  → dict
# etc.
```

**Complete Signature**:
```python
def {snake_case_name}({params_with_types}) -> {return_type}:
```

#### 3. Docstring (Google Style)

**Structure**:
```python
"""
{purpose}

Algorithm:
    {algorithmStrategy}  # If present

Args:
    {param_name}: {param.description}  # For each input
    ...

Returns:
    {outputs.description}

Raises:
    {ErrorName}: {error.when}  # For each error
    ...
"""
```

**Formatting Rules**:
- Purpose: First line, complete sentence
- Algorithm: Indented, wrapped at ~80 chars
- Args: One per line, name + description
- Returns: Single description (or "See interface outputs specification" if missing)
- Raises: One per line, exception type + condition

#### 4. Function Body

**ALWAYS** (safety-critical):
```python
raise NotImplementedError('{function_name} not yet implemented')
```

**NEVER**:
- Actual implementation logic
- Algorithm strategy as code (only in docstring)
- eval() or exec()
- Placeholder code like `pass` (must raise NotImplementedError)

#### 5. Traceability Comment

If module has `implementsRequirements`:
```python
# Implements req-001, req-003
def function_name(...):
```

#### 6. Imports

Collect all schema entity types referenced in `outputs.schemaReference` or `inputs.*.schemaReference`:

```python
from generated.models import Template, Section, Contract
```

**Import Resolution**:
```
schemaReference: "contract-template-updater.Template"
                 ↓
Schema Name: contract-template-updater
Entity Type: Template
                 ↓
Import: from generated.models import Template
```

---

## Pattern 2: TestSpecification → Pytest Function

### Input: TestSpecification (JSON)

```json
{
  "id": "test-001",
  "module": "mod-001",
  "scenario": "req-001: Correctly identifies all PW section style types",
  "testType": "unit",
  "given": [
    "A DOCX template file exists with multiple PW section markers",
    "The template contains PWSectionDefault, PWSectionMandatory, and PWSectionOptional styles"
  ],
  "when": "parse_template is called with the template path",
  "then": [
    "All PW section markers are identified and extracted",
    "Each section is labeled with its correct PW style type",
    "The returned Template entity contains a sections array with PW marker metadata"
  ],
  "validatesRequirement": "req-001",
  "validatesAcceptanceCriteria": "Correctly identifies all PW section style types in a document"
}
```

### Output: Pytest Test Function

```python
def test_req_001_correctly_identifies_all_pw_section_style_types():
    """req-001: Correctly identifies all PW section style types

    Validates: req-001
    Acceptance Criteria: Correctly identifies all PW section style types in a document
    """
    # Given: Setup
    # - A DOCX template file exists with multiple PW section markers
    # - The template contains PWSectionDefault, PWSectionMandatory, and PWSectionOptional styles

    # When: Action
    # parse_template is called with the template path
    # TODO: Implement function call
    # result = parse_template(...)

    # Then: Assertions
    # - All PW section markers are identified and extracted
    # TODO: assert ...
    # - Each section is labeled with its correct PW style type
    # TODO: assert ...
    # - The returned Template entity contains a sections array with PW marker metadata
    # TODO: assert ...

    # Placeholder: Remove when implementing test
    assert False, 'Test not yet implemented'
```

### Transformation Rules

#### 1. Test Function Name

```
Input:  scenario (free text with "req-XXX:" prefix)
Output: test_{snake_case}

Algorithm:
  1. Remove "req-XXX:" prefix if present
  2. Remove special characters (keep alphanumeric and spaces)
  3. Replace spaces with underscores
  4. Convert to lowercase
  5. Prepend "test_"

Examples:
  "req-001: Parse valid DOCX template"
    → test_parse_valid_docx_template

  "req-002: Detects added sections in new template"
    → test_detects_added_sections_in_new_template
```

#### 2. Docstring

**Structure**:
```python
"""{scenario}

Validates: {validatesRequirement}
Acceptance Criteria: {validatesAcceptanceCriteria}
"""
```

#### 3. Test Body: Given/When/Then Transformation

**Given Statements** → Setup Comments
```python
# Given: Setup
# - {given[0]}
# - {given[1]}
# ...
```

**When Statement** → Action Comments
```python
# When: Action
# {when}
# TODO: Implement function call
# result = function_under_test(...)
```

**Then Statements** → Assertion Comments
```python
# Then: Assertions
# - {then[0]}
# TODO: assert ...
# - {then[1]}
# TODO: assert ...
```

**Placeholder Failure** (RED Phase):
```python
# Placeholder: Remove when implementing test
assert False, 'Test not yet implemented'
```

**Why Placeholders?**
- Ensures RED phase (tests must fail)
- Makes TODOs explicit
- Prevents false positives (tests passing due to missing assertions)

#### 4. Advanced: Fixture Generation (Optional, Session 2+)

If `given` statements are complex, generate pytest fixtures:

```python
# Given statement:
# "A DOCX template file exists at tests/fixtures/sample.docx"

# Generated fixture:
@pytest.fixture
def sample_template_path():
    """Fixture providing path to sample DOCX template"""
    return Path("tests/fixtures/sample.docx")

# Test using fixture:
def test_parse_valid_template(sample_template_path):
    result = parse_template(sample_template_path)
    assert isinstance(result, Template)
```

**Session 1 Baseline**: Comment-only (no fixtures yet)
**Session 2**: Generate fixtures for file paths, test data

#### 5. Imports

```python
import pytest  # Always

# If using generated types in assertions:
from generated.models import Template, Section

# If importing functions under test:
from src.modules.document_parser import parse_template
```

---

## Pattern 3: Enhanced JSON Schema → Pydantic v2 Models

### Input: Enhanced JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "contract-template-updater",
  "name": "contract-template-updater",
  "$defs": {
    "Template": {
      "type": "object",
      "properties": {
        "id": { "type": "string" },
        "filename": { "type": "string" },
        "totalSections": { "type": "number" },
        "sections": {
          "type": "array",
          "items": { "$ref": "#/$defs/Section" }
        }
      },
      "required": ["id", "filename", "totalSections", "sections"]
    },
    "Section": {
      "type": "object",
      "properties": {
        "sectionName": { "type": "string" },
        "content": { "type": "string" },
        "order": { "type": "number" }
      },
      "required": ["sectionName"]
    }
  }
}
```

### Output: Pydantic v2 Models

```python
"""
AUTO-GENERATED Pydantic Models from Wavesmith Schema

⚠️  DO NOT EDIT THIS FILE MANUALLY - IT WILL BE OVERWRITTEN ⚠️

Source: schema.json (hash: 5b01a98314ab)
Generated: 2025-10-31 12:34:56 UTC
Schema: contract-template-updater (id: 8a3339fb-f1e5-473e-8319-581dba9c14ac)
Models: 2 entities

To regenerate after schema changes:
    python scripts/build_types.py
"""

from __future__ import annotations

from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field


class Section(BaseModel):
    model_config = ConfigDict(
        populate_by_name=True,
    )
    section_name: Annotated[str, Field(alias='sectionName')]
    content: str | None = None
    order: float | None = None


class Template(BaseModel):
    model_config = ConfigDict(
        populate_by_name=True,
    )
    id: str
    filename: str
    total_sections: Annotated[float, Field(alias='totalSections')]
    sections: list[Section]
```

### Transformation Tool: datamodel-codegen

**Command Pattern** (from build_types.py):
```bash
datamodel-codegen \
    --input schema.json \
    --output generated/models.py \
    --input-file-type jsonschema \
    --output-model-type pydantic_v2.BaseModel \
    --field-constraints \
    --use-annotated \
    --snake-case-field \
    --use-standard-collections \
    --use-union-operator \
    --target-python-version 3.11 \
    --disable-timestamp \
    --reuse-model \
    --allow-population-by-field-name
```

**Flag Explanations**:
- `--field-constraints`: Preserve min/max, enums from schema
- `--use-annotated`: Pydantic v2.5+ style (Annotated types)
- `--snake-case-field`: Python naming (sectionName → section_name)
- `--allow-population-by-field-name`: Accept both snake_case and camelCase

### Post-Generation Steps

1. **Add Header** (via build_types.py):
```python
def add_header_to_generated_file(output_path, schema_hash, metadata):
    header = f'''"""
AUTO-GENERATED Pydantic Models from Wavesmith Schema
Source: schema.json (hash: {schema_hash})
Generated: {datetime.now(timezone.utc)}
...
"""
'''
    # Prepend to file
```

2. **Create __init__.py**:
```python
"""Generated Pydantic models from wavesmith schema."""

from .models import *

__all__ = ['Template', 'Section', ...]
```

3. **Validate with mypy**:
```bash
mypy generated/models.py
```

---

## Pattern 4: ModuleSpecification → Module Directory

### Input: ModuleSpecification

```json
{
  "id": "mod-001",
  "session": "impl-sess-001",
  "name": "document-parser",
  "purpose": "Parse DOCX templates and extract structure",
  "category": "input",
  "details": {
    "algorithm": "DOCX parsing",
    "libraries": ["python-docx", "lxml"],
    "pwMarkerPattern": "<<.*?>>"
  },
  "implementsRequirements": ["req-001", "req-002"],
  "interfaces": ["iface-001", "iface-002"],
  "tests": ["test-001", "test-002", "test-003"]
}
```

### Output: Module Directory Structure

```
src/modules/document_parser/
├── __init__.py
└── parser.py          # Contains all function stubs from interfaces
```

**File: `__init__.py`**:
```python
"""document-parser Module

Purpose: Parse DOCX templates and extract structure

This module was generated from Layer 2.5 implementation specifications.
"""
```

**File: `parser.py`**:
```python
"""
document_parser Module

Auto-generated function stubs from Layer 2.5 implementation specifications.
...
"""

from generated.models import Template, Contract

# Implements req-001, req-002
def parse_template(...):
    ...

def parse_contract(...):
    ...
```

### Transformation Rules

#### 1. Directory Name
```
Input:  ModuleSpecification.name (kebab-case or camelCase)
Output: snake_case directory name

Examples:
  "document-parser"   → document_parser/
  "comparisonEngine"  → comparison_engine/
```

#### 2. File Organization

**Pattern**:
```
src/modules/{module_name}/
├── __init__.py               # Module-level docstring
└── {module_name}.py          # All stubs for this module
```

**Why co-locate?** (Session 1)
- Simpler structure
- All module functions in one file
- Easier to review and validate

**Future** (Session 2+):
- Split into multiple files if >10 functions
- Organize by subdomain (e.g., parsers/, transformers/)

#### 3. Requirement Extraction

From `details.libraries`:
```json
"details": {
  "libraries": ["python-docx", "lxml", "pytest"]
}
```

**Add to requirements.txt**:
```
python-docx>=0.8.11
lxml>=4.9.0
pytest>=7.0.0
```

---

## Pattern 5: TestSpecification[] → Test File

### Input: Multiple TestSpecifications for One Module

```json
[
  {
    "id": "test-001",
    "module": "mod-001",
    "scenario": "Parse valid DOCX template",
    ...
  },
  {
    "id": "test-002",
    "module": "mod-001",
    "scenario": "Handle missing file error",
    ...
  },
  {
    "id": "test-003",
    "module": "mod-001",
    "scenario": "Extract PW section markers",
    ...
  }
]
```

### Output: Single Test File

```
tests/test_document_parser.py
```

**Structure**:
```python
"""
Tests for document_parser Module

Auto-generated test scaffolding from Layer 2.5 test specifications.
...
"""

import pytest
from src.modules.document_parser import parse_template
from generated.models import Template

def test_parse_valid_docx_template():
    ...

def test_handle_missing_file_error():
    ...

def test_extract_pw_section_markers():
    ...
```

### Transformation Rules

#### 1. File Naming
```
Input:  ModuleSpecification.name
Output: tests/test_{snake_case}.py

Examples:
  "document-parser" → tests/test_document_parser.py
  "comparisonEngine" → tests/test_comparison_engine.py
```

#### 2. Test Organization

**All tests for one module in one file** (Session 1 baseline)

**Future** (Session 2+):
- Split by test type: `test_parser_unit.py`, `test_parser_integration.py`
- Split by subdomain if >20 tests

---

## Validation Patterns

### Syntax Validation: ast.parse

**After generating ANY .py file**:
```python
import ast

def validate_syntax(code: str, file_path: Path) -> bool:
    try:
        ast.parse(code)
        return True
    except SyntaxError as e:
        print(f"❌ Syntax error in {file_path}:")
        print(f"   Line {e.lineno}: {e.msg}")
        return False
```

**Why ast.parse?**
- Validates Python syntax without execution
- No import of generated modules (avoids running module-level code)
- Fast and deterministic

### Type Validation: mypy

**After generating all stubs**:
```bash
mypy src/
```

**What it catches**:
- Type hint errors
- Missing imports
- Incorrect return types
- Schema entity reference typos

### Test Collection Validation: pytest --collect-only

**After generating all tests**:
```bash
pytest --collect-only tests/
```

**What it catches**:
- Import errors in test files
- Invalid pytest syntax
- Missing fixtures
- Duplicate test names

**Does NOT run tests** (no execution, no NotImplementedError failures yet)

### RED Phase Validation: pytest

**Final validation step**:
```bash
pytest tests/
```

**Expected**: ALL tests fail with `NotImplementedError` or placeholder assertions

**If any test PASSES** → ERROR (tests should fail in RED phase)

---

## Domain Adaptation Examples

### Example: Document Processing (KPMG Case)

**Inputs** (Layer 2.5):
- Schema: Template, Section, Contract entities
- Modules: document-parser, comparison-engine
- Libraries: python-docx, lxml

**Outputs** (Layer 3):
- Types: Pydantic models with camelCase↔snake_case aliases
- Stubs: Functions parsing DOCX using type-safe Template entities
- Tests: Validate PW marker extraction, section comparison

### Example: Data Pipeline (Hypothetical)

**Inputs**:
- Schema: DataSource, TransformationRun, DataObject entities
- Modules: connector, transformer, validator
- Libraries: pandas, sqlalchemy

**Outputs**:
- Types: Pydantic models for pipeline entities
- Stubs: ETL functions with DataFrame hints
- Tests: Validate data extraction, transformation logic

### Example: Web App (Hypothetical)

**Inputs**:
- Schema: Component, Category, Example entities
- Modules: component-renderer, state-manager
- Libraries: react (via TypeScript, not Python)

**Outputs** (if Python backend):
- Types: API response models
- Stubs: API endpoint handlers
- Tests: Validate API contracts, state management

---

## Anti-Patterns (NEVER DO)

### ❌ Hallucinated Implementations

**Wrong**:
```python
def parse_template(template_path: str) -> Template:
    """Parse template."""
    # LLM invents implementation:
    doc = Document(template_path)
    sections = []
    for para in doc.paragraphs:
        if para.style.name.startswith('PW'):
            sections.append(Section(content=para.text))
    return Template(sections=sections)
```

**Right**:
```python
def parse_template(template_path: str) -> Template:
    """Parse template.

    Algorithm:
        Unzip DOCX, parse with python-docx, extract PW markers.
    """
    raise NotImplementedError('parse_template not yet implemented')
```

### ❌ Invented Function Names

**Wrong**:
```python
# Function not in InterfaceContracts:
def helper_extract_sections():
    ...
```

**Right**: Only generate functions from InterfaceContracts.

### ❌ Schema Entity Assumptions

**Wrong**:
```python
# Assuming 'User' entity exists without validation:
def get_user() -> User:
    ...
```

**Right**:
```python
# 1. Validate 'User' in schema.$defs BEFORE generation
# 2. If missing, fail with clear error
# 3. Only generate if validated
```

### ❌ Placeholders Instead of NotImplementedError

**Wrong**:
```python
def parse_template() -> Template:
    pass  # Or: return None, or: return {}
```

**Right**:
```python
def parse_template() -> Template:
    raise NotImplementedError('parse_template not yet implemented')
```

**Why?** NotImplementedError is explicit, catchable, and conventional for TDD RED phase.

---

## Summary: Transformation Checklist

For each generated artifact:

- [ ] **Evidence-Based**: Derived from Layer 2.5 entity, not invented
- [ ] **Syntax Valid**: Passes ast.parse
- [ ] **Type Safe**: Schema references validated, imports correct
- [ ] **Traceable**: Comments link to requirements
- [ ] **Conventional**: Follows Python/pytest naming and style
- [ ] **Safe**: NotImplementedError bodies only (no executable logic)
- [ ] **Documented**: Docstrings from interface purpose + algorithm strategy
- [ ] **Testable**: Tests fail in RED phase as expected

When in doubt, **be conservative**. Generate minimal, safe code. Trust the TDD process - developers will implement the GREEN phase.
