#!/usr/bin/env python3
"""
Project Scaffolding Orchestrator

Creates the base project structure for code generation following the kpmg-contract-parser pattern:
- Directory structure (src/modules/, tests/, scripts/, generated/)
- Virtual environment
- Configuration files (.gitignore, requirements.txt, pyproject.toml)
- Schema copy from Layer 2
- build_types.py script for schema→Pydantic generation

Usage:
    python scripts/init_project.py --session-name <name> --schema-path <path> --workspace <path>
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path


def create_directory_structure(workspace: Path):
    """Create base directory structure for Python project."""
    dirs = [
        workspace / "src" / "modules",
        workspace / "tests",
        workspace / "scripts",
        workspace / "generated",
    ]

    for dir_path in dirs:
        dir_path.mkdir(parents=True, exist_ok=True)
        print(f"✅ Created directory: {dir_path.relative_to(workspace)}/")


def create_package_files(workspace: Path, session_name: str):
    """Create __init__.py files for package structure and pytest.ini."""

    # Create src/__init__.py
    src_init = workspace / "src" / "__init__.py"
    src_init.write_text(f'''"""
{session_name}
Auto-generated TDD-ready Python project from Layer 2.5 implementation specs.
"""
''')
    print(f"✅ Created package file: src/__init__.py")

    # Create src/modules/__init__.py
    modules_init = workspace / "src" / "modules" / "__init__.py"
    modules_init.write_text('''"""
modules package
Contains all implementation modules.
"""
''')
    print(f"✅ Created package file: src/modules/__init__.py")

    # Create generated/__init__.py
    generated_init = workspace / "generated" / "__init__.py"
    generated_init.write_text('''"""
generated package
Auto-generated Pydantic models from schema.json (DO NOT EDIT)
"""
''')
    print(f"✅ Created package file: generated/__init__.py")

    # Create pytest.ini
    pytest_ini = workspace / "pytest.ini"
    pytest_ini.write_text('''[pytest]
pythonpath = .
testpaths = tests
python_files = test_*.py
python_classes = Test*
python_functions = test_*
''')
    print(f"✅ Created pytest.ini")


def create_venv(workspace: Path):
    """Create Python virtual environment."""
    venv_path = workspace / ".venv"

    if venv_path.exists():
        print(f"⏭️  Virtual environment already exists: .venv/")
        return

    print("🔧 Creating virtual environment...")
    try:
        subprocess.run(
            [sys.executable, "-m", "venv", str(venv_path)],
            check=True,
            capture_output=True
        )
        print(f"✅ Created virtual environment: .venv/")
    except subprocess.CalledProcessError as e:
        print(f"❌ Failed to create venv: {e.stderr.decode()}")
        sys.exit(1)


def copy_schema(schema_path: Path, workspace: Path):
    """Copy Layer 2 schema to workspace root."""
    dest = workspace / "schema.json"

    if dest.exists():
        print(f"⏭️  Schema already exists: schema.json")
        return

    shutil.copy(schema_path, dest)

    # Validate it's valid JSON
    with open(dest) as f:
        schema = json.load(f)

    print(f"✅ Copied schema: schema.json ({len(schema.get('$defs', {}))} entities)")


def create_gitignore(workspace: Path):
    """Create .gitignore for Python project."""
    gitignore_path = workspace / ".gitignore"

    content = """# Python
__pycache__/
*.py[cod]
*$py.class
*.so
.Python
.venv/
venv/
ENV/
env/

# Testing
.pytest_cache/
.coverage
htmlcov/

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Generated files
generated/models.py
*.egg-info/
dist/
build/
"""

    gitignore_path.write_text(content)
    print(f"✅ Created .gitignore")


def create_requirements(workspace: Path, extra_libs: list[str] = None):
    """Create requirements.txt with base dependencies + extras from specs."""
    requirements_path = workspace / "requirements.txt"

    base_deps = [
        "pydantic>=2.0",
        "pytest>=7.0",
        "mypy>=1.0",
        "datamodel-code-generator>=0.25.0",
    ]

    all_deps = base_deps + (extra_libs or [])

    requirements_path.write_text("\n".join(all_deps) + "\n")
    print(f"✅ Created requirements.txt ({len(all_deps)} dependencies)")


def install_dependencies(workspace: Path):
    """Install dependencies in venv."""
    pip_path = workspace / ".venv" / "bin" / "pip"
    requirements_path = workspace / "requirements.txt"

    if not pip_path.exists():
        print("⚠️  Virtual environment pip not found, skipping install")
        return

    print("📦 Installing dependencies...")
    try:
        subprocess.run(
            [str(pip_path), "install", "-r", str(requirements_path)],
            check=True,
            capture_output=True
        )
        print("✅ Dependencies installed")
    except subprocess.CalledProcessError as e:
        print(f"❌ Failed to install dependencies: {e.stderr.decode()}")
        # Not fatal - can continue


def create_readme(workspace: Path, session_name: str):
    """Create basic README.md."""
    readme_path = workspace / "README.md"

    content = f"""# {session_name}

Generated Python code from Layer 2.5 implementation specifications.

## Project Structure

```
{session_name}/
├── schema.json              # Layer 2 application schema (source of truth)
├── scripts/
│   └── build_types.py       # Regenerate Pydantic models from schema
├── generated/
│   ├── __init__.py
│   └── models.py            # Auto-generated Pydantic models (DO NOT EDIT)
├── src/
│   └── modules/             # Function stubs (implement here)
├── tests/                   # pytest tests (RED phase - should fail)
├── requirements.txt
└── README.md

```

## Setup

```bash
# Activate virtual environment
source .venv/bin/activate

# Verify installation
python -m pytest --version
python -m mypy --version
```

## TDD Workflow

### RED Phase (Current State)

All tests are generated and should fail with `NotImplementedError`:

```bash
pytest
```

Expected: All tests fail predictably.

### GREEN Phase (Next Step)

Implement functions in `src/modules/` to make tests pass:

1. Choose a module to implement
2. Implement functions (replace `NotImplementedError`)
3. Run tests: `pytest tests/test_<module>.py`
4. Repeat until tests pass

### REFACTOR Phase

Once tests pass, improve implementation:

- Extract common logic
- Optimize performance
- Improve readability
- Tests provide safety net

## Schema-Driven Development

When schema evolves:

```bash
# 1. Edit schema.json (or regenerate from Layer 2)
# 2. Regenerate Pydantic models
python scripts/build_types.py

# 3. Fix type errors in implementation
mypy src/

# 4. Run tests
pytest
```

## Type Safety

All generated stubs use type hints from schema entities:

```python
from generated.models import Template, Section

def parse_template(template_path: str) -> Template:
    # Implementation here
    ...
```

Run type checker:

```bash
mypy src/
```

## Traceability

Every function and test links back to requirements:

```python
# Implements req-001
def parse_template(template_path: str) -> Template:
    \"\"\"Parse template and extract structure (req-001)\"\"\"
    ...
```

Query traceability:

```bash
# Which function implements req-001?
grep -r "req-001" src/

# Which tests validate req-003?
grep -r "req-003" tests/
```
"""

    readme_path.write_text(content)
    print(f"✅ Created README.md")


def main():
    parser = argparse.ArgumentParser(description="Initialize code generation project")
    parser.add_argument("--session-name", required=True, help="Name of implementation session")
    parser.add_argument("--schema-path", required=True, help="Path to Layer 2 schema.json")
    parser.add_argument("--workspace", required=True, help="Workspace directory to create")
    parser.add_argument("--extra-libs", nargs="*", help="Extra dependencies from specs")

    args = parser.parse_args()

    workspace = Path(args.workspace)
    schema_path = Path(args.schema_path)

    print("=" * 60)
    print(f"Initializing Project: {args.session_name}")
    print("=" * 60)
    print()

    # Validate inputs
    if not schema_path.exists():
        print(f"❌ Schema not found: {schema_path}")
        sys.exit(1)

    # Create structure
    workspace.mkdir(parents=True, exist_ok=True)
    print(f"📁 Workspace: {workspace}\n")

    create_directory_structure(workspace)
    create_package_files(workspace, args.session_name)
    create_venv(workspace)
    copy_schema(schema_path, workspace)
    create_gitignore(workspace)
    create_requirements(workspace, args.extra_libs)
    install_dependencies(workspace)
    create_readme(workspace, args.session_name)

    print()
    print("=" * 60)
    print("✅ Project initialized successfully!")
    print("=" * 60)
    print()
    print("Next steps:")
    print(f"  1. cd {workspace}")
    print("  2. source .venv/bin/activate")
    print("  3. Copy build_types.py script to scripts/")
    print("  4. Run: python scripts/build_types.py")
    print("  5. Generate function stubs and tests")


if __name__ == "__main__":
    main()
