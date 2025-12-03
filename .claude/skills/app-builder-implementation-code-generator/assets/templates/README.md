# Template Assets for View-Projection Workflow

This directory contains domain-agnostic Nunjucks templates for projecting Wavesmith spec entities to JSON artifacts consumed by code generation scripts.

## Overview

These templates enable the **template-driven projection pattern** where Wavesmith state is materialized to disk via the view-projection system, providing:

- **Stronger schema connection**: Artifacts directly linked to source entities via metadata
- **Reduced inference overhead**: Templates handle serialization, freeing agent for orchestration
- **Higher confidence**: Deterministic, reproducible projections with traceability

## Templates

### `interfaces.njk`

**Purpose**: Project `InterfaceContract` entities to JSON for `generate_stubs.py`

**Input Data Source**: Query view filtering InterfaceContract by `moduleId`

**Output Structure**:
```json
{
  "module_id": "mod-xyz",
  "generated_at": "2025-10-31T...",
  "interfaces": [
    {
      "id": "iface-001",
      "function_name": "parse_template",
      "inputs": {...},
      "outputs": {...},
      "requirements": [...],
      "description": "...",
      "algorithm_strategy": "...",
      "_source": "wavesmith://InterfaceContract/iface-001",
      "_schema": "app-builder-implementation-spec",
      "_view": "module_interfaces_json"
    }
  ],
  "_metadata": {
    "count": 1,
    "schema": "app-builder-implementation-spec",
    "view": "module_interfaces_json",
    "generated_at": "2025-10-31T..."
  }
}
```

**Consumed By**: `scripts/generate_stubs.py --interfaces <file>`

### `tests.njk`

**Purpose**: Project `TestSpecification` entities to JSON for `generate_tests.py`

**Input Data Source**: Query view filtering TestSpecification by `moduleId`

**Output Structure**:
```json
{
  "module_id": "mod-xyz",
  "generated_at": "2025-10-31T...",
  "tests": [
    {
      "id": "test-001",
      "test_name": "test_parse_template_valid_docx",
      "test_type": "unit",
      "tested_interface": "iface-001",
      "inputs": {...},
      "expected_outputs": {...},
      "description": "...",
      "_source": "wavesmith://TestSpecification/test-001",
      "_schema": "app-builder-implementation-spec",
      "_view": "module_tests_json"
    }
  ],
  "_metadata": {
    "count": 1,
    "schema": "app-builder-implementation-spec",
    "view": "module_tests_json",
    "generated_at": "2025-10-31T..."
  }
}
```

**Consumed By**: `scripts/generate_tests.py --tests <file>`

## Usage Workflow

### 1. Copy Templates to Workspace (First Use)

```bash
# Copy to workspace templates directory
cp .claude/skills/app-builder-implementation-code-generator/assets/templates/*.njk \
   .schemas/{schema-name}/templates/
```

### 2. Define Views (First Use or Check-and-Define)

```javascript
// Query view: Filter interfaces by module
await mcp__wavesmith__view_define({
  schema: "app-builder-implementation-spec",
  name: "module_interfaces",
  definition: {
    type: "query",
    collection: "InterfaceContract",
    filter: { module: "${moduleId}" },
    select: ["id", "functionName", "inputs", "outputs", "requirements", "description", "algorithmStrategy"]
  }
})

// Template view: Render interfaces as JSON
await mcp__wavesmith__view_define({
  schema: "app-builder-implementation-spec",
  name: "module_interfaces_json",
  definition: {
    type: "template",
    dataSource: "module_interfaces",
    template: "interfaces.njk"
  }
})

// Repeat for module_tests / module_tests_json
```

### 3. Project Data

```javascript
// Project interfaces for a specific module
const result = await mcp__wavesmith__view_project({
  schema: "app-builder-implementation-spec",
  view: "module_interfaces_json",
  params: { moduleId: "mod-xyz" },
  output_path: ".schemas/app-builder-implementation-spec/tmp/mod-xyz-interfaces.json",
  ensure_directory: true
})

// Validation (agent discretion)
if (result.metadata.entity_count === 0) {
  console.warn(`No interfaces found for module mod-xyz`)
}
```

### 4. Consume Projected Artifacts

```bash
# Generate function stubs using projected interfaces
.venv/bin/python scripts/generate_stubs.py \
  --interfaces .schemas/app-builder-implementation-spec/tmp/mod-xyz-interfaces.json \
  --schema-name my-app-schema \
  --module-name document_parser \
  --output src/modules/document_parser/parser.py
```

## Template Context Variables

All templates receive these standard context variables from the view-projection system:

| Variable | Type | Description |
|----------|------|-------------|
| `data` | Array | Entities from the query view data source |
| `schema_name` | String | Name of the Wavesmith schema |
| `view_name` | String | Name of the view being executed |
| `timestamp` | String | ISO 8601 timestamp of projection |
| `entity_count` | Number | Count of entities in data array |

## Traceability Metadata

Each projected entity includes traceability fields:

- `_source`: Wavesmith URI identifying source entity (e.g., `wavesmith://InterfaceContract/iface-001`)
- `_schema`: Schema name for verification
- `_view`: View name that produced this artifact

Root-level `_metadata` provides projection-level information.

## Design Principles

1. **Domain-Agnostic**: No assumptions about specific application domains or module types
2. **Traceability**: Every artifact links back to source entities
3. **Consumption-Oriented**: Output structure matches what code generators expect
4. **Metadata-Rich**: Embedded provenance enables verification and drift detection

## When to Use View-Projection

**Use when:**
- Working with complete, stable specs in Wavesmith
- Generating code for multiple modules (reproducibility matters)
- Want strong connection between specs and generated artifacts
- Token efficiency is important (large specs)

**Skip when:**
- Prototyping or exploring (manual control preferred)
- Specs are small (overhead not justified)
- Agent prefers direct data access for specific workflow

## Validation Patterns

**Mandatory checks** (in scripts):
- Entity count > 0 (catch empty projections)
- JSON structure valid (parseable, expected fields present)

**Agent discretion**:
- Metadata verification (_source, _schema present and correct)
- Content spot-checking (sample entities have expected structure)
- Re-projection and diff (detect drift when specs change)

## Troubleshooting

**Empty projection (entity_count: 0)**:
- Check moduleId parameter matches actual module IDs in Wavesmith
- Verify query view filter is correct
- Ensure entities exist in Wavesmith for that module

**Template not found error**:
- Verify templates copied to `.schemas/{schema-name}/templates/`
- Check template filename matches view definition exactly
- Ensure working directory is correct when calling view.project

**Render error (invalid Nunjucks syntax)**:
- Check template syntax using Nunjucks validator
- Verify data array contains expected fields
- Look for missing or null values in entity fields

## References

- View-projection system documentation: `references/view-projection-patterns.md`
- Standard view definitions for implementor: `references/view-projection-patterns.md`
- Session validation results: See `_analysis/app-builder/case-studies/wavesmith-porting-iterations/interaction-tuning/implementor/`
