#!/usr/bin/env python3
"""
Function Stub Generator

Transforms InterfaceContract entities into type-safe Python function stubs with:
- snake_case naming (from camelCase)
- Type hints from schema entity references
- Google-style docstrings
- NotImplementedError bodies (safety-critical)
- Traceability comments

Usage:
    python scripts/generate_stubs.py --interfaces <json-file> --schema-name <name> --output <path>
"""

import argparse
import ast
import json
import re
import sys
from pathlib import Path
from typing import Any


def camel_to_snake(name: str) -> str:
    """Convert camelCase to snake_case."""
    # Insert underscore before uppercase letters
    s1 = re.sub('(.)([A-Z][a-z]+)', r'\1_\2', name)
    return re.sub('([a-z0-9])([A-Z])', r'\1_\2', s1).lower()


def extract_type_from_schema_ref(schema_ref: str) -> tuple[str, str]:
    """
    Extract entity type from schemaReference.

    Args:
        schema_ref: Format "schema-name.EntityName"

    Returns:
        (schema_name, entity_type)
    """
    if '.' not in schema_ref:
        return "", schema_ref

    parts = schema_ref.split('.')
    return parts[0], parts[1]


def generate_type_hint(param: dict, schema_name: str) -> str:
    """Generate Python type hint from interface parameter."""
    param_type = param.get('type', 'Any')

    # Map JSON Schema types to Python types
    type_map = {
        'string': 'str',
        'number': 'float',
        'integer': 'int',
        'boolean': 'bool',
        'array': 'list',
        'object': 'dict',
    }

    # If type is not in basic map, check if it's a schema entity type
    if param_type not in type_map:
        # Check if there's a schemaReference
        if param.get('schemaReference'):
            _, entity_type = extract_type_from_schema_ref(param['schemaReference'])
            return entity_type
        # Handle array types like "SectionMatch[]"
        if param_type.endswith('[]'):
            base_type = param_type[:-2]
            return f"List[{base_type}]"
        # Otherwise assume it's a direct entity type name (e.g., "Template", "Contract")
        return param_type

    return type_map.get(param_type, 'Any')


def generate_return_type(outputs: dict, schema_name: str) -> str:
    """
    Generate return type annotation from interface outputs.

    If outputs has schemaReference, use that entity type.
    Otherwise, infer from type field.
    """
    schema_ref = outputs.get('schemaReference')

    if schema_ref:
        _, entity_type = extract_type_from_schema_ref(schema_ref)
        return entity_type

    output_type = outputs.get('type', 'Any')

    # Handle array types like "SectionMatch[]"
    if output_type.endswith('[]'):
        base_type = output_type[:-2]  # Remove '[]'
        return f"List[{base_type}]"

    type_map = {
        'string': 'str',
        'number': 'float',
        'integer': 'int',
        'boolean': 'bool',
        'array': 'list',
        'object': 'dict',
    }

    return type_map.get(output_type, 'Any')


def collect_imports(interfaces: list[dict], schema_name: str) -> tuple[set[str], bool, bool]:
    """
    Collect all schema entity types that need to be imported.

    Returns:
        (entity_types, needs_any, needs_list): Tuple of entity type names, whether Any is needed, and whether List is needed
    """
    entity_types = set()
    needs_any = False
    needs_list = False

    # Known basic types that don't need imports
    # Includes both JSON Schema type names and Python type names
    basic_types = {
        # JSON Schema types (from InterfaceContract JSON)
        'string', 'number', 'integer', 'boolean', 'array', 'object',
        # Python types (for defensive checking)
        'str', 'int', 'float', 'bool', 'list', 'dict', 'Any'
    }

    for interface in interfaces:
        # Check outputs
        outputs = interface.get('outputs', {})
        schema_ref = outputs.get('schemaReference')
        if schema_ref:
            _, entity_type = extract_type_from_schema_ref(schema_ref)
            entity_types.add(entity_type)
        else:
            output_type = outputs.get('type', '')
            # Handle array types like "SectionMatch[]"
            if output_type.endswith('[]'):
                base_type = output_type[:-2]
                entity_types.add(base_type)
                needs_list = True
            elif output_type == 'object' and not schema_ref:
                # Plain object type needs Any
                needs_any = True

        # Check inputs
        inputs = interface.get('inputs', {})
        for param_name, param in inputs.items():
            if not isinstance(param, dict):
                continue

            param_type = param.get('type', '')

            # Check for schemaReference
            if param.get('schemaReference'):
                _, entity_type = extract_type_from_schema_ref(param['schemaReference'])
                entity_types.add(entity_type)
            # Handle array types like "SectionMatch[]"
            elif param_type.endswith('[]'):
                base_type = param_type[:-2]
                entity_types.add(base_type)
                needs_list = True
            # Check if type is a schema entity (not a basic type)
            elif param_type and param_type not in basic_types:
                # Likely a schema entity type name
                entity_types.add(param_type)
            # Check for plain object/dict types
            elif param_type in ['object', 'dict']:
                needs_any = True

    return entity_types, needs_any, needs_list


def generate_function_signature(interface: dict, schema_name: str) -> str:
    """Generate function signature with type hints."""
    func_name = camel_to_snake(interface['functionName'])
    inputs = interface.get('inputs', {})
    outputs = interface.get('outputs', {})

    # Generate parameters
    params = []
    for param_name, param in inputs.items():
        if isinstance(param, dict):
            type_hint = generate_type_hint(param, schema_name)
            params.append(f"{param_name}: {type_hint}")
        else:
            params.append(f"{param_name}")

    # Generate return type
    return_type = generate_return_type(outputs, schema_name)

    params_str = ", ".join(params) if params else ""

    return f"def {func_name}({params_str}) -> {return_type}:"


def generate_docstring(interface: dict) -> str:
    """Generate Google-style docstring."""
    purpose = interface.get('purpose', '')
    inputs = interface.get('inputs', {})
    outputs = interface.get('outputs', {})
    errors = interface.get('errors', {})
    algorithm = interface.get('algorithmStrategy', '')

    lines = ['"""', purpose, '']

    # Algorithm strategy
    if algorithm:
        lines.append("Algorithm:")
        lines.append(f"    {algorithm}")
        lines.append("")

    # Args
    if inputs:
        lines.append("Args:")
        for param_name, param in inputs.items():
            if isinstance(param, dict):
                desc = param.get('description', '')
                lines.append(f"    {param_name}: {desc}")
        lines.append("")

    # Returns
    if outputs:
        desc = outputs.get('description', '')
        lines.append("Returns:")
        lines.append(f"    {desc if desc else 'See interface outputs specification'}")
        lines.append("")

    # Raises
    if errors:
        lines.append("Raises:")
        for error_name, error_info in errors.items():
            if isinstance(error_info, dict):
                when = error_info.get('when', '')
                lines.append(f"    {error_name}: {when}")
        lines.append("")

    lines.append('"""')

    return "\n    ".join(lines)


def generate_stub(interface: dict, schema_name: str, module_req_ids: list[str] = None) -> str:
    """Generate complete function stub."""
    func_name = camel_to_snake(interface['functionName'])

    # Traceability comment
    req_comment = ""
    if module_req_ids:
        req_comment = f"# Implements: {', '.join(module_req_ids)}\n"

    signature = generate_function_signature(interface, schema_name)
    docstring = generate_docstring(interface)
    body = f"raise NotImplementedError('{func_name} not yet implemented')"

    return f"""{req_comment}{signature}
    {docstring}
    {body}
"""


def generate_module_file(
    interfaces: list[dict],
    schema_name: str,
    module_name: str,
    module_req_ids: list[str] = None
) -> str:
    """Generate complete module file with all function stubs."""

    # Collect imports
    entity_types, needs_any, needs_list = collect_imports(interfaces, schema_name)

    # Generate module docstring
    module_doc = f'''"""
{module_name} Module

Auto-generated function stubs from Layer 2.5 implementation specifications.

⚠️  IMPLEMENTATION REQUIRED - Replace NotImplementedError with actual logic ⚠️

TDD Workflow:
    1. Run tests (RED phase - should fail)
    2. Implement function logic (GREEN phase)
    3. Refactor with test safety net (REFACTOR phase)
"""
'''

    # Generate imports
    imports = ["from __future__ import annotations\n"]

    # Add typing imports if needed
    typing_imports = []
    if needs_any:
        typing_imports.append("Any")
    if needs_list:
        typing_imports.append("List")

    if typing_imports:
        imports.append(f"from typing import {', '.join(typing_imports)}")

    # Add schema entity imports
    if entity_types:
        entity_list = ", ".join(sorted(entity_types))
        imports.append(f"from generated.models import {entity_list}")

    imports.append("")

    # Generate all stubs
    stubs = []
    for interface in interfaces:
        stub = generate_stub(interface, schema_name, module_req_ids)
        stubs.append(stub)

    # Combine all parts
    parts = [module_doc] + imports + ["\n\n".join(stubs)]

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


def main():
    parser = argparse.ArgumentParser(description="Generate function stubs from interface contracts")
    parser.add_argument("--interfaces", required=True, help="JSON file with InterfaceContract array")
    parser.add_argument("--schema-name", required=True, help="Application schema name for imports")
    parser.add_argument("--module-name", required=True, help="Module name")
    parser.add_argument("--output", required=True, help="Output Python file path")
    parser.add_argument("--req-ids", nargs="*", help="Requirement IDs this module implements")

    args = parser.parse_args()

    interfaces_path = Path(args.interfaces)
    output_path = Path(args.output)

    print("=" * 60)
    print("Function Stub Generator")
    print("=" * 60)
    print()

    # Load interfaces
    with open(interfaces_path) as f:
        interfaces = json.load(f)

    if not isinstance(interfaces, list):
        print(f"❌ Expected array of interfaces, got {type(interfaces)}")
        sys.exit(1)

    print(f"📄 Interfaces: {len(interfaces)} contracts")
    print(f"📦 Schema: {args.schema_name}")
    print(f"🎯 Module: {args.module_name}")
    print()

    # Generate code
    code = generate_module_file(
        interfaces,
        args.schema_name,
        args.module_name,
        args.req_ids
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
    print(f"   Functions: {len(interfaces)}")
    print()

    # Update __init__.py with function exports
    init_path = output_path.parent / "__init__.py"
    module_file_name = output_path.stem  # Get filename without extension

    # Extract function names from interfaces
    function_names = [camel_to_snake(iface['functionName']) for iface in interfaces]

    # Generate __init__.py content with exports
    init_content = f'''"""Module package."""

from .{module_file_name} import {", ".join(function_names)}

__all__ = {function_names}
'''

    init_path.write_text(init_content)
    print(f"✅ Updated: {init_path}")
    print(f"   Exports: {', '.join(function_names)}")
    print()

    print("Next steps:")
    print(f"  1. Review generated stubs in {output_path}")
    print("  2. Generate tests")
    print("  3. Run mypy for type checking")


if __name__ == "__main__":
    main()
