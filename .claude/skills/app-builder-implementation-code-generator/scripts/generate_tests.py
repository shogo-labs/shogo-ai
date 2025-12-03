#!/usr/bin/env python3
"""
Pytest Test Generator

Transforms TestSpecification entities into executable pytest tests with:
- test_{snake_case} naming
- Given/When/Then → setup/action/assert transformation
- Traceability docstrings
- Imports from generated stubs

Usage:
    python scripts/generate_tests.py --tests <json-file> --module-name <name> --output <path>
"""

import argparse
import ast
import json
import re
import subprocess
import sys
from pathlib import Path


def scenario_to_test_name(scenario: str) -> str:
    """Convert scenario text to test function name."""
    # Remove req-XXX prefix if present
    clean = re.sub(r'^req-\d+:\s*', '', scenario, flags=re.IGNORECASE)

    # Replace spaces and special chars with underscores
    clean = re.sub(r'[^\w\s]', '', clean)
    clean = re.sub(r'\s+', '_', clean)

    return f"test_{clean.lower()}"


def generate_test_function(test_spec: dict, module_name: str) -> str:
    """Generate pytest test function from TestSpecification."""
    test_name = scenario_to_test_name(test_spec['scenario'])
    scenario = test_spec['scenario']
    given_statements = test_spec.get('given', [])
    when_statement = test_spec.get('when', '')
    then_statements = test_spec.get('then', [])
    validates_req = test_spec.get('validatesRequirement', '')
    validates_ac = test_spec.get('validatesAcceptanceCriteria', '')

    # Build docstring
    docstring_parts = [f'"""{scenario}']

    if validates_req:
        docstring_parts.append(f"\n    Validates: {validates_req}")

    if validates_ac:
        docstring_parts.append(f"    Acceptance Criteria: {validates_ac}")

    docstring_parts.append('"""')

    docstring = "\n    ".join(docstring_parts)

    # Build test body
    body_lines = []

    # Given section
    if given_statements:
        body_lines.append("# Given: Setup")
        for given in given_statements:
            # Convert given statements to comments initially
            # In real implementation, might create fixtures
            body_lines.append(f"# - {given}")

        body_lines.append("")

    # When section
    if when_statement:
        body_lines.append("# When: Action")
        body_lines.append(f"# {when_statement}")
        body_lines.append("# TODO: Implement function call")
        body_lines.append("# result = function_under_test(...)")
        body_lines.append("")

    # Then section
    if then_statements:
        body_lines.append("# Then: Assertions")
        for then in then_statements:
            body_lines.append(f"# - {then}")
            body_lines.append("# TODO: assert ...")

        body_lines.append("")

    # Placeholder failure (RED phase)
    body_lines.append("# Placeholder: Remove when implementing test")
    body_lines.append("assert False, 'Test not yet implemented'")

    body = "\n    ".join(body_lines)

    return f"""def {test_name}():
    {docstring}
    {body}
"""


def generate_test_file(
    test_specs: list[dict],
    module_name: str,
    module_imports: list[str] = None
) -> str:
    """Generate complete test file with all test functions."""

    # Module docstring
    module_doc = f'''"""
Tests for {module_name} Module

Auto-generated test scaffolding from Layer 2.5 test specifications.

⚠️  IMPLEMENTATION REQUIRED - Replace placeholders with actual test logic ⚠️

Current State: RED Phase
    All tests should fail (either NotImplementedError from stubs or assertion failures)

Next Step: GREEN Phase
    Implement functions to make tests pass

TDD Workflow:
    1. Run pytest (confirm RED phase)
    2. Implement one function
    3. Run tests again (should turn GREEN)
    4. Refactor with test safety
    5. Repeat for next function
"""
'''

    # Generate imports
    imports = ["import pytest"]

    if module_imports:
        for import_stmt in module_imports:
            imports.append(import_stmt)

    imports.append("")

    # Generate all tests
    tests = []
    for test_spec in test_specs:
        test = generate_test_function(test_spec, module_name)
        tests.append(test)

    # Combine all parts
    parts = [module_doc] + imports + ["\n\n".join(tests)]

    return "\n".join(parts)


def validate_syntax(code: str, file_path: Path) -> bool:
    """Validate Python syntax using ast.parse."""
    try:
        ast.parse(code)
        return True
    except SyntaxError as e:
        print(f"❌ Syntax error in {file_path}:")
        print(f"   Line {e.lineno}: {e.msg}")
        print(f"   {e.text}")
        return False


def validate_collectible(file_path: Path) -> bool:
    """Validate tests are collectible with pytest."""
    try:
        result = subprocess.run(
            ["pytest", "--collect-only", str(file_path)],
            capture_output=True,
            text=True,
            timeout=10
        )

        if result.returncode == 0:
            return True
        else:
            print(f"❌ pytest collection failed:")
            print(result.stdout)
            print(result.stderr)
            return False

    except FileNotFoundError:
        print("⚠️  pytest not found, skipping collection validation")
        return True  # Not fatal
    except subprocess.TimeoutExpired:
        print("⚠️  pytest collection timed out")
        return False


def main():
    parser = argparse.ArgumentParser(description="Generate pytest tests from test specifications")
    parser.add_argument("--tests", required=True, help="JSON file with TestSpecification array")
    parser.add_argument("--module-name", required=True, help="Module name being tested")
    parser.add_argument("--output", required=True, help="Output test file path")
    parser.add_argument("--imports", nargs="*", help="Import statements for module functions")

    args = parser.parse_args()

    tests_path = Path(args.tests)
    output_path = Path(args.output)

    print("=" * 60)
    print("Pytest Test Generator")
    print("=" * 60)
    print()

    # Load test specs
    with open(tests_path) as f:
        test_specs = json.load(f)

    if not isinstance(test_specs, list):
        print(f"❌ Expected array of test specs, got {type(test_specs)}")
        sys.exit(1)

    print(f"📄 Test Specs: {len(test_specs)} scenarios")
    print(f"🎯 Module: {args.module_name}")
    print()

    # Generate code
    code = generate_test_file(
        test_specs,
        args.module_name,
        args.imports
    )

    # Validate syntax
    print("🔍 Validating syntax...")
    if not validate_syntax(code, output_path):
        sys.exit(1)

    print("✅ Syntax valid")
    print()

    # Write file
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(code)

    print(f"✅ Generated: {output_path}")
    print(f"   Lines: {len(code.splitlines())}")
    print(f"   Tests: {len(test_specs)}")
    print()

    # Validate collectible (if pytest available)
    print("🔍 Validating test collection...")
    if validate_collectible(output_path):
        print("✅ Tests are collectible")
    else:
        print("⚠️  Test collection validation failed (review manually)")

    print()
    print("Next steps:")
    print(f"  1. Review generated tests in {output_path}")
    print("  2. Implement actual test logic (replace placeholders)")
    print("  3. Run: pytest tests/")
    print("  4. Confirm RED phase (all tests should fail)")


if __name__ == "__main__":
    main()
