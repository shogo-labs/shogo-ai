# Safety Guidelines: Code Generation Safety-Critical Requirements

## Why Code Generation is Different

**Layers 1, 2, 2.5, 2.7**: Generate data structures, specifications, documentation → LOW RISK

**Layer 3 (Code Generation)**: Generates executable code → HIGH RISK

### Risks of LLM-Generated Code

- **Logic Errors**: Incorrect algorithms, edge case failures
- **Security Vulnerabilities**: SQL injection, arbitrary code execution, credential exposure
- **Performance Issues**: Inefficient algorithms, resource waste
- **Type Safety Violations**: Runtime errors, schema mismatches
- **Subtle Bugs**: Off-by-one errors, race conditions, memory leaks

**Mitigation**: Strict safety boundaries, validation-first approach, TDD philosophy

---

## Safety Tiers (Session Progression)

### Session 1: Stubs Only (SAFEST - Baseline)

**What is Generated**:
- Function signatures with type hints
- Docstrings (purpose, algorithm strategy)
- `NotImplementedError` bodies ONLY

**What is NOT Generated**:
- No executable logic
- No algorithm implementations
- No data transformations
- No I/O operations

**Safety Level**: ⭐⭐⭐⭐⭐ (Maximum)

**Validation**:
```python
# Every function body MUST be exactly:
raise NotImplementedError('{function_name} not yet implemented')
```

**Example**:
```python
def parse_template(template_path: str) -> Template:
    """Parse DOCX template and extract structure.

    Algorithm:
        Unzip DOCX, parse with python-docx, extract PW markers.
    """
    raise NotImplementedError('parse_template not yet implemented')
```

**Philosophy**: Provide scaffolding, not intelligence. Let developers implement safely.

### Session 2: TDD Skeletons (Safe - If Session 1 Validated)

**What is Generated**:
- Stubs remain (NotImplementedError)
- Full test implementations (Given/When/Then → actual pytest code)
- Test fixtures
- Test data setup

**What is NOT Generated**:
- Still no function implementations

**Safety Level**: ⭐⭐⭐⭐ (High)

**Validation**:
- Tests import stubs successfully
- Tests fail with NotImplementedError (RED phase confirmed)
- No false positives (tests passing due to missing assertions)

**Example**:
```python
def test_parse_valid_template(sample_template_path):
    """Parse valid DOCX template"""
    # Setup
    assert sample_template_path.exists()

    # Action
    result = parse_template(sample_template_path)

    # Assertions
    assert isinstance(result, Template)
    assert result.id is not None
    assert len(result.sections) == 3
```

### Session 3+: Targeted Implementation (Risky - Only If Validated)

**Criteria for Attempting**:
- [ ] Session 1 validation: 0 interventions
- [ ] Session 2 validation: 0 interventions
- [ ] Quality gates: 100% pass rate
- [ ] Manual review approved

**What MIGHT be Generated** (very selective):
- Simple, deterministic implementations ONLY
- No complex business logic
- No security-sensitive operations
- No performance-critical code

**Safety Level**: ⭐⭐ (Low - High Risk)

**Allowed Patterns**:
```python
# ✅ Simple file reading
def load_json(file_path: str) -> dict:
    with open(file_path, 'r') as f:
        return json.load(f)

# ✅ Simple data transformation
def to_snake_case(s: str) -> str:
    return s.replace('-', '_').lower()
```

**Forbidden Patterns**:
```python
# ❌ Complex parsing logic
def parse_docx(path):
    # Too complex for LLM to reliably generate

# ❌ Security-sensitive
def authenticate_user(username, password):
    # Never trust LLM-generated auth logic

# ❌ Performance-critical
def sort_large_dataset(data):
    # Optimization requires domain expertise
```

---

## Safety-Critical Rules (ALWAYS)

### Rule 1: NotImplementedError-Only Bodies (Session 1)

**Validation**:
```python
import ast
import re

def validate_function_body_is_safe(func_node: ast.FunctionDef) -> bool:
    """
    Verify function body contains ONLY raise NotImplementedError(...).

    Returns:
        True if safe, False if potentially dangerous code detected
    """
    # Function body should have exactly 1 statement
    if len(func_node.body) != 1:
        return False

    stmt = func_node.body[0]

    # Must be a Raise statement
    if not isinstance(stmt, ast.Raise):
        return False

    # Must raise NotImplementedError
    if not isinstance(stmt.exc, ast.Call):
        return False

    if not isinstance(stmt.exc.func, ast.Name):
        return False

    if stmt.exc.func.id != 'NotImplementedError':
        return False

    return True


# Usage:
tree = ast.parse(generated_code)
for node in ast.walk(tree):
    if isinstance(node, ast.FunctionDef):
        if not node.name.startswith('test_'):  # Skip test functions
            assert validate_function_body_is_safe(node), \
                f"Function {node.name} contains executable logic (forbidden)"
```

### Rule 2: No Code Execution During Validation

**Why**: Generated code might contain malicious or buggy logic

**Safe Validation**:
```python
# ✅ Safe: Parse syntax without execution
ast.parse(code)

# ✅ Safe: Type checking without execution
subprocess.run(['mypy', 'src/'], check=True)

# ✅ Safe: Test collection without execution
subprocess.run(['pytest', '--collect-only', 'tests/'], check=True)
```

**Unsafe Validation**:
```python
# ❌ Unsafe: Imports execute module-level code
import src.modules.parser  # Might run __name__ == '__main__' block

# ❌ Unsafe: eval/exec can run arbitrary code
eval(generated_expression)
exec(generated_code)

# ❌ Unsafe: Running tests in validation phase
subprocess.run(['pytest', 'tests/'])  # Should only run after manual review
```

### Rule 3: Algorithm Strategy in Docstrings, Not Code

**Wrong** (LLM generates implementation from strategy):
```python
# algorithmStrategy: "Unzip DOCX, parse with python-docx, extract markers"

def parse_template(path: str) -> Template:
    # LLM invents this:
    doc = Document(path)  # ❌ Hallucinated
    sections = []
    for para in doc.paragraphs:
        if para.style.name.startswith('PW'):
            sections.append(Section(content=para.text))
    return Template(sections=sections)
```

**Right** (Strategy as documentation, not implementation):
```python
def parse_template(path: str) -> Template:
    """Parse DOCX template and extract structure.

    Algorithm:
        Unzip DOCX to access document.xml. Parse using python-docx library.
        Extract PW section markers by matching paragraph styles against
        known patterns (PWSectionMandatory, PWSectionOptional, etc.).
        Build hierarchical section structure based on heading levels.
    """
    raise NotImplementedError('parse_template not yet implemented')
```

**Why**: Developers implement correctly by reading algorithm, not LLM guessing.

### Rule 4: No eval(), exec(), or subprocess of Generated Code

**Forbidden**:
```python
# ❌ Never do this:
eval(f"result = {function_name}()")
exec(generated_code)
subprocess.run(['python', generated_script])
```

**Safe Alternatives**:
```python
# ✅ Syntax validation
ast.parse(generated_code)

# ✅ Type checking (external process, no imports)
subprocess.run(['mypy', 'src/'], check=True)

# ✅ Import validation (check AST, don't import)
tree = ast.parse(code)
imports = [node.names[0].name for node in ast.walk(tree)
           if isinstance(node, ast.Import)]
```

### Rule 5: Validate Schema References Before Generation

**Before Generating Code**:
```python
def validate_schema_references(
    interfaces: list[dict],
    schema: dict
) -> tuple[bool, list[str]]:
    """
    Validate all InterfaceContract.outputs.schemaReference entities exist.

    Returns:
        (valid, error_messages)
    """
    entity_types = schema.get('$defs', {}).keys()
    errors = []

    for interface in interfaces:
        schema_ref = interface.get('outputs', {}).get('schemaReference')

        if schema_ref:
            # Parse "schema-name.EntityName"
            if '.' in schema_ref:
                _, entity_type = schema_ref.split('.', 1)
            else:
                entity_type = schema_ref

            if entity_type not in entity_types:
                errors.append(
                    f"Interface {interface['id']}: "
                    f"Entity '{entity_type}' not found in schema"
                )

    return (len(errors) == 0, errors)


# Usage:
valid, errors = validate_schema_references(interfaces, schema)
if not valid:
    print("❌ Schema validation failed!")
    for error in errors:
        print(f"  • {error}")
    sys.exit(1)
```

**Why**: Catch broken references before generating code with invalid type hints.

---

## Validation Strategy (3-Tier)

### Tier 1: Syntax Validation

**Tool**: `ast.parse`

**What it Catches**:
- Syntax errors (missing colons, mismatched parentheses)
- Invalid Python constructs
- Indentation errors

**What it Doesn't Catch**:
- Type errors
- Logic errors
- Runtime errors

**Run After**: Every file generation

**Example**:
```python
import ast

try:
    ast.parse(generated_code)
    print("✅ Syntax valid")
except SyntaxError as e:
    print(f"❌ Syntax error at line {e.lineno}: {e.msg}")
    sys.exit(1)
```

### Tier 2: Type Validation

**Tool**: `mypy`

**What it Catches**:
- Type hint errors
- Missing imports
- Incorrect return types
- Schema entity reference typos

**What it Doesn't Catch**:
- Logic errors
- Runtime errors (None checks, etc.)

**Run After**: All stubs generated

**Example**:
```bash
mypy src/ --strict
```

**Strict Mode Flags**:
```ini
[mypy]
python_version = 3.11
strict = True
warn_return_any = True
warn_unused_configs = True
disallow_untyped_defs = True
disallow_any_generics = True
```

### Tier 3: Test Validation

**Tool**: `pytest`

**Phase 1: Collection Validation**
```bash
pytest --collect-only tests/
```

**What it Catches**:
- Import errors in test files
- Invalid pytest syntax
- Missing fixtures
- Duplicate test names

**What it Doesn't Catch**:
- Test logic errors (not executed yet)

**Phase 2: RED Phase Validation**
```bash
pytest tests/
```

**Expected**: ALL tests fail with NotImplementedError

**What it Confirms**:
- Tests are runnable
- Tests import stubs correctly
- NotImplementedError is raised (not pass or other failure)

**Validation Logic**:
```python
import subprocess
import re

def validate_red_phase(test_output: str) -> tuple[bool, str]:
    """
    Verify all tests failed with NotImplementedError.

    Returns:
        (is_red_phase, message)
    """
    # Check for test failures
    if 'PASSED' in test_output:
        return (False, "Some tests passed (should fail in RED phase)")

    # Check all failures are NotImplementedError
    failures = re.findall(r'(FAILED.*)', test_output)

    if not failures:
        return (False, "No test failures found")

    # Verify NotImplementedError in output
    if 'NotImplementedError' not in test_output:
        return (False, "Tests failed but not with NotImplementedError")

    return (True, f"RED phase confirmed: {len(failures)} tests failed correctly")


# Usage:
result = subprocess.run(['pytest', 'tests/'], capture_output=True, text=True)
is_red, message = validate_red_phase(result.stdout)

if not is_red:
    print(f"❌ RED phase validation failed: {message}")
    sys.exit(1)

print(f"✅ {message}")
```

---

## TDD Philosophy: RED → GREEN → REFACTOR

### RED Phase (Layer 3 Responsibility)

**Goal**: Generate failing tests and stubs

**Deliverables**:
- Function stubs with NotImplementedError
- Test scaffolding with placeholders
- All tests fail predictably

**Validation**:
- `pytest` shows all tests failing
- Failure message contains NotImplementedError
- No tests pass accidentally

**Example Output**:
```
============================= test session starts ==============================
collected 24 items

tests/test_document_parser.py FFF                                       [ 12%]
tests/test_comparison_engine.py FFFFF                                   [ 33%]
...

====================== 24 failed in 0.52s =======================

test_parse_valid_template FAILED
    NotImplementedError: parse_template not yet implemented
```

### GREEN Phase (Developer Responsibility)

**Goal**: Implement functions to make tests pass

**Workflow**:
1. Choose one function to implement
2. Read its docstring (purpose + algorithm strategy)
3. Implement function body (replace NotImplementedError)
4. Run tests: `pytest tests/test_{module}.py`
5. Iterate until tests pass
6. Move to next function

**Layer 3 Support**:
- Clear docstrings with algorithm strategies
- Type hints guide implementation
- Tests provide acceptance criteria

**Example**:
```python
# Before (generated by Layer 3):
def parse_template(template_path: str) -> Template:
    """..."""
    raise NotImplementedError('parse_template not yet implemented')

# After (implemented by developer):
def parse_template(template_path: str) -> Template:
    """..."""
    doc = Document(template_path)
    sections = []
    for para in doc.paragraphs:
        if para.style.name.startswith('PW'):
            sections.append(Section(
                section_name=para.text,
                content=extract_content(para)
            ))
    return Template(
        id=str(uuid.uuid4()),
        filename=Path(template_path).name,
        total_sections=len(sections),
        sections=sections
    )
```

### REFACTOR Phase (Developer Responsibility)

**Goal**: Improve implementation with test safety net

**Actions**:
- Extract common logic to helper functions
- Optimize performance
- Improve readability
- Add error handling

**Confidence**: Tests ensure refactoring doesn't break functionality

**Example**:
```python
# Before refactor (passes tests but messy):
def parse_template(template_path: str) -> Template:
    doc = Document(template_path)
    sections = []
    for para in doc.paragraphs:
        if para.style.name.startswith('PW'):
            sec = Section(...)
            sections.append(sec)
    return Template(...)

# After refactor (cleaner, same behavior):
def parse_template(template_path: str) -> Template:
    doc = load_docx(template_path)  # Extracted
    sections = extract_pw_sections(doc)  # Extracted
    return build_template(template_path, sections)  # Extracted
```

---

## Security Considerations

### What Code Generation Must Never Do

**1. Arbitrary Code Execution**
```python
# ❌ FORBIDDEN
eval(user_input)
exec(generated_code)
__import__(user_provided_module)
```

**2. Shell Injection**
```python
# ❌ FORBIDDEN
os.system(f"rm -rf {user_input}")
subprocess.run(f"curl {user_url}", shell=True)
```

**3. SQL Injection**
```python
# ❌ FORBIDDEN
cursor.execute(f"SELECT * FROM users WHERE id = {user_id}")
```

**4. Path Traversal**
```python
# ❌ FORBIDDEN
open(user_provided_path, 'r')  # Without validation
```

**5. Hardcoded Secrets**
```python
# ❌ FORBIDDEN
API_KEY = "sk-1234567890abcdef"
PASSWORD = "admin123"
```

### Safe Alternatives

**1. Parameterized Queries**
```python
# ✅ Safe
cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
```

**2. Path Validation**
```python
# ✅ Safe
from pathlib import Path

def safe_read(file_path: str) -> str:
    path = Path(file_path).resolve()
    if not path.is_relative_to(ALLOWED_DIR):
        raise ValueError("Path outside allowed directory")
    return path.read_text()
```

**3. Environment Variables**
```python
# ✅ Safe
import os

API_KEY = os.getenv('API_KEY')
if not API_KEY:
    raise ValueError("API_KEY not set")
```

---

## Error Handling in Generated Code

### Session 1: No Error Handling

**Rationale**: Developers add error handling during GREEN phase

**Generated**:
```python
def parse_template(template_path: str) -> Template:
    """..."""
    raise NotImplementedError('parse_template not yet implemented')
```

**Not Generated**:
```python
# ❌ Don't generate this in Session 1:
def parse_template(template_path: str) -> Template:
    try:
        # Implementation
    except FileNotFoundError:
        # Error handling
```

### Session 2+: Targeted Error Handling

**IF validated in Session 1**, MAY generate basic error handling:

```python
def parse_template(template_path: str) -> Template:
    """Parse DOCX template.

    Raises:
        FileNotFoundError: Template file does not exist
        InvalidDOCXError: File is not valid DOCX format
    """
    if not Path(template_path).exists():
        raise FileNotFoundError(f"Template not found: {template_path}")

    # Stub continues:
    raise NotImplementedError('parse_template not yet implemented')
```

**Safety**: Only raise built-in exceptions, no custom handling logic yet.

---

## Summary: Safety Checklist

Before generating ANY code:

- [ ] Session 1 baseline: stubs-only (NotImplementedError)
- [ ] No executable logic in function bodies
- [ ] Algorithm strategies in docstrings, not code
- [ ] All schema references validated before generation
- [ ] Syntax validation (ast.parse) after each file
- [ ] Type validation (mypy) after all stubs
- [ ] Test collection validation (pytest --collect-only)
- [ ] RED phase validation (all tests fail with NotImplementedError)
- [ ] No eval(), exec(), or subprocess of generated code
- [ ] Clear headers: "AUTO-GENERATED - DO NOT EDIT"
- [ ] Safety boundaries documented in README
- [ ] Developers understand: implement GREEN phase manually

**If ANY checkpoint fails → STOP, fix, validate again.**

Layer 3 is about **safe scaffolding**, not **intelligent implementation**. Trust the process.
