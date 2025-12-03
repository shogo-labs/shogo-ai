# Transformation Patterns: Layer 2.5 → Layer 2.7

## Core Principle: Evidence-Based Transformation

**Never invent content. Always extract from source entities.**

All documentation content must be traceable back to Layer 2.5 entities (ModuleSpecification, InterfaceContract, TestSpecification) or cross-layer context (Layer 1 requirements, Layer 2 schema).

## Generic Pattern Template

Every transformation follows this structure:

```
1. Identify source entities
2. Extract evidence from entity fields
3. Validate cross-layer references
4. Apply domain-agnostic template
5. Populate with domain-specific content (from opaque fields)
6. Link to traceability chain
7. Generate related diagrams
```

---

## Pattern 1: ModuleSpecification → Implementation Guide

### Source Entity

```typescript
ModuleSpecification {
  id: string
  name: string  // e.g., "template-parser"
  purpose: string  // High-level description
  category: "input" | "process" | "output"
  details: object  // OPAQUE - domain-specific
  implementsRequirements: Requirement[]
  dependsOn: ModuleSpecification[]
  interfaces: InterfaceContract[]
  tests: TestSpecification[]
}
```

### Transformation Algorithm

```python
def module_to_implementation_guide(module: ModuleSpecification) -> DocumentEntity:
    # 1. Extract evidence
    name = module.name
    purpose = module.purpose
    category = module.category
    details = module.details  # Domain-specific content
    requirements = module.implementsRequirements
    dependencies = module.dependsOn
    interfaces = module.interfaces
    tests = module.tests

    # 2. Structure content (domain-agnostic template)
    content = {
        "overview": {
            "name": name,
            "purpose": purpose,
            "category": category_label(category)
        },
        "requirements": {
            "implements": [req.description for req in requirements],
            "traceability": [req.id for req in requirements]
        },
        "architecture": {
            "dependencies": [dep.name for dep in dependencies],
            "provides_interfaces": [iface.functionName for iface in interfaces]
        },
        "implementation_guidance": extract_guidance(details),  # Domain-specific
        "algorithms": extract_algorithms(details),  # Domain-specific
        "testing": {
            "scenarios": [test.scenario for test in tests],
            "coverage": f"{len(tests)} test scenarios"
        }
    }

    # 3. Generate markdown
    markdown = format_implementation_guide(content)

    # 4. Create entity
    return DocumentEntity(
        type="implementation-guide",
        title=f"{name} Implementation Guide",
        content={"markdown": markdown},
        references={
            "module": module.id,
            "requirements": [r.id for r in requirements],
            "interfaces": [i.id for i in interfaces],
            "tests": [t.id for t in tests]
        },
        metadata={"category": category}
    )
```

### Category Labels (Domain-Agnostic)

```python
def category_label(category: str) -> str:
    return {
        "input": "Input Module - Brings data into the system",
        "process": "Process Module - Transforms or analyzes data",
        "output": "Output Module - Generates results or artifacts"
    }[category]
```

### Domain-Specific Extraction

Extract from opaque `details` field:

```python
def extract_guidance(details: dict) -> str:
    # KPMG example: Extract PracticeWorks patterns
    if "practiceWorks" in details:
        return format_pw_guidance(details["practiceWorks"])

    # Invoice example: Extract validation rules
    if "validation" in details:
        return format_validation_guidance(details["validation"])

    # Generic fallback
    return format_generic_guidance(details)
```

---

## Pattern 2: InterfaceContract → API Reference

### Source Entity

```typescript
InterfaceContract {
  id: string
  functionName: string  // e.g., "parse_template"
  purpose: string
  inputs: object  // OPAQUE - may reference Layer 2 entities
  outputs: object  // OPAQUE - may reference Layer 2 entities
  errors: object  // OPAQUE
  algorithmStrategy: string
}
```

### Transformation Algorithm

```python
def interface_to_api_reference(interface: InterfaceContract, schema_entities) -> DocumentEntity:
    # 1. Extract evidence
    name = interface.functionName
    purpose = interface.purpose
    inputs = interface.inputs
    outputs = interface.outputs
    errors = interface.errors or {}
    algorithm = interface.algorithmStrategy

    # 2. Validate schema references
    input_types = validate_schema_refs(inputs, schema_entities)
    output_types = validate_schema_refs(outputs, schema_entities)

    # 3. Structure content
    content = {
        "signature": {
            "name": name,
            "purpose": purpose
        },
        "parameters": format_parameters(inputs, input_types),
        "returns": format_returns(outputs, output_types),
        "errors": format_errors(errors),
        "algorithm": algorithm,
        "usage_notes": generate_usage_notes(inputs, outputs)
    }

    # 4. Generate markdown
    markdown = format_api_reference(content)

    return DocumentEntity(
        type="api-reference",
        title=f"{name} API Reference",
        content={"markdown": markdown},
        references={
            "interface": interface.id,
            "module": interface.module,
            "schema_entities": list(input_types.keys()) + list(output_types.keys())
        },
        metadata={"function_name": name}
    )
```

### Schema Reference Validation

```python
def validate_schema_refs(io_spec: dict, schema_entities: dict) -> dict:
    """
    Extract entity type references from interface I/O specifications.

    Example input spec:
    {
        "template_path": {"type": "string", "description": "Path to DOCX"},
        "options": {"type": "object", "description": "Parse options"}
    }

    Example output spec:
    {
        "template": {"entity": "Template", "description": "Parsed template"}
    }
    """
    entity_refs = {}

    for param_name, param_spec in io_spec.items():
        if "entity" in param_spec:
            entity_name = param_spec["entity"]
            if entity_name in schema_entities:
                entity_refs[entity_name] = schema_entities[entity_name]
            else:
                warn(f"Schema entity '{entity_name}' referenced but not found")

    return entity_refs
```

---

## Pattern 3: TestSpecification → Test Documentation

### Source Entity

```typescript
TestSpecification {
  id: string
  scenario: string
  testType: "unit" | "integration" | "acceptance"
  given: string[]  // Preconditions (abstract)
  when: string  // Action (abstract)
  then: string[]  // Expected outcomes (abstract)
  validatesRequirement: Requirement
  validatesAcceptanceCriteria: string
}
```

### Transformation Algorithm

```python
def test_to_documentation(test: TestSpecification) -> DocumentEntity:
    # 1. Extract evidence
    scenario = test.scenario
    test_type = test.testType
    given = test.given
    when = test.when
    then = test.then
    requirement = test.validatesRequirement
    criteria = test.validatesAcceptanceCriteria

    # 2. Structure content
    content = {
        "scenario": scenario,
        "type": test_type_label(test_type),
        "specification": {
            "given": given,
            "when": when,
            "then": then
        },
        "traceability": {
            "requirement": requirement.description if requirement else None,
            "criteria": criteria
        },
        "notes": generate_test_notes(test_type, given, when, then)
    }

    # 3. Generate markdown (Given/When/Then format)
    markdown = format_test_documentation(content)

    return DocumentEntity(
        type="test-documentation",
        title=scenario,
        content={"markdown": markdown},
        references={
            "test": test.id,
            "module": test.module,
            "requirement": requirement.id if requirement else None
        },
        metadata={"test_type": test_type}
    )
```

### Test Type Labels

```python
def test_type_label(test_type: str) -> str:
    return {
        "unit": "Unit Test - Tests individual function behavior",
        "integration": "Integration Test - Tests module interactions",
        "acceptance": "Acceptance Test - Validates requirement fulfillment"
    }[test_type]
```

---

## Pattern 4: ModuleSpecification.dependsOn → Architecture Diagram

### Source Data

```python
# From all ModuleSpecifications in the session
modules = implementation_session.modules
dependencies = {
    module.name: [dep.name for dep in module.dependsOn]
    for module in modules
}
categories = {
    module.name: module.category
    for module in modules
}
```

### Transformation Algorithm

```python
def modules_to_architecture_diagram(modules: List[ModuleSpecification]) -> Diagram:
    # 1. Extract graph structure
    nodes = [(m.name, m.category, m.purpose) for m in modules]
    edges = [(m.name, dep.name) for m in modules for dep in m.dependsOn]

    # 2. Generate Mermaid graph
    mermaid = generate_mermaid_architecture(nodes, edges)

    return Diagram(
        type="architecture",
        format="mermaid",
        source={"mermaid": mermaid},
        references={
            "modules": [m.id for m in modules]
        }
    )

def generate_mermaid_architecture(nodes, edges):
    """
    Generate Mermaid graph with category-based styling.

    Example output:
    ```mermaid
    graph LR
        TemplateParser[template-parser<br/>input]
        ContractParser[contract-parser<br/>input]
        ComparisonEngine[comparison-engine<br/>process]
        TrackChangesGen[track-changes-generator<br/>output]

        TemplateParser --> ComparisonEngine
        ContractParser --> ComparisonEngine
        ComparisonEngine --> TrackChangesGen
    ```
    """
    lines = ["graph LR"]

    # Add nodes with category labels
    for name, category, purpose in nodes:
        node_id = to_mermaid_id(name)
        label = f"{name}<br/>{category}"
        lines.append(f"    {node_id}[{label}]")

    # Add edges
    for source, target in edges:
        source_id = to_mermaid_id(source)
        target_id = to_mermaid_id(target)
        lines.append(f"    {source_id} --> {target_id}")

    return "\n".join(lines)
```

---

## Pattern 5: InterfaceContract I/O Chain → Data Flow Diagram

### Source Data

```python
# From all InterfaceContracts in the session
interfaces = [i for m in modules for i in m.interfaces]
data_flow = extract_io_chain(interfaces)
```

### Transformation Algorithm

```python
def interfaces_to_dataflow_diagram(interfaces: List[InterfaceContract], schema) -> Diagram:
    # 1. Extract I/O chain
    flow_nodes = []
    for interface in interfaces:
        # Input entities
        for input_name, input_spec in interface.inputs.items():
            if "entity" in input_spec:
                flow_nodes.append((input_spec["entity"], interface.functionName, "input"))

        # Output entities
        for output_name, output_spec in interface.outputs.items():
            if "entity" in output_spec:
                flow_nodes.append((interface.functionName, output_spec["entity"], "output"))

    # 2. Generate Mermaid flowchart
    mermaid = generate_mermaid_dataflow(flow_nodes)

    return Diagram(
        type="dataflow",
        format="mermaid",
        source={"mermaid": mermaid},
        references={
            "interfaces": [i.id for i in interfaces],
            "schema_entities": extract_entity_names(flow_nodes)
        }
    )

def generate_mermaid_dataflow(flow_nodes):
    """
    Example output:
    ```mermaid
    graph LR
        User -->|DOCX path| parse_template
        parse_template -->|Template entity| compare_templates
        compare_templates -->|ComparisonRun entity| generate_track_changes
        generate_track_changes -->|DOCX output| User
    ```
    """
    lines = ["graph LR"]

    for source, target, label in flow_nodes:
        lines.append(f"    {source} -->|{label}| {target}")

    return "\n".join(lines)
```

---

## Pattern 6: Full Session → Provenance Artifact

### Source Data

```python
# Aggregate all layers
documentation_session = get_current_session()
implementation_session = documentation_session.implementationSession
discovery_session = documentation_session.discoverySession  # May be None
app_schema = load_schema(documentation_session.appSchemaName)
```

### Transformation Algorithm

```python
def session_to_provenance_artifact(doc_session: DocumentationSession) -> DocumentEntity:
    # 1. Gather full provenance chain
    provenance = {
        "layer1": extract_discovery_context(doc_session.discoverySession),
        "layer2": extract_schema_summary(doc_session.appSchemaName),
        "layer2.5": extract_implementation_summary(doc_session.implementationSession),
        "layer2.7": extract_documentation_summary(doc_session)
    }

    # 2. Invoke artifacts-builder skill
    artifact_html = invoke_artifacts_builder(provenance)

    # 3. Create entity
    return DocumentEntity(
        type="provenance",
        title="Full Provenance Chain",
        content={"html": artifact_html},
        references={
            "documentation_session": doc_session.id,
            "implementation_session": doc_session.implementationSession,
            "discovery_session": doc_session.discoverySession,
            "schema": doc_session.appSchemaName
        },
        metadata={"format": "interactive-html"}
    )

def invoke_artifacts_builder(provenance: dict) -> str:
    """
    Compose with artifacts-builder skill to generate rich interactive visualization.

    Skill invocation pattern:
    ```
    Skill: artifacts-builder

    Generate an interactive HTML artifact visualizing the full provenance chain from
    discovery through documentation for the app-builder system.

    Include:
    - Layer 1: Problem statement, requirements, acceptance criteria
    - Layer 2: Domain schema with entity relationships
    - Layer 2.5: Modules, interfaces, and test specifications
    - Layer 2.7: Generated documentation artifacts

    Make it interactive: click through relationships, explore traceability,
    understand "why was this built this way?"

    Data: {provenance}
    ```
    """
    # Actual implementation would invoke the skill
    # For now, return placeholder
    return generate_provenance_html(provenance)
```

---

## Pattern 7: TestSpecification[] → Test Coverage Matrix

### Source Data

```python
tests = [t for m in modules for t in m.tests]
requirements = get_all_requirements(discovery_session)
```

### Transformation Algorithm

```python
def tests_to_coverage_diagram(tests: List[TestSpecification], requirements) -> Diagram:
    # 1. Build coverage map
    coverage = {}
    for req in requirements:
        coverage[req.id] = [t for t in tests if t.validatesRequirement == req.id]

    # 2. Generate Mermaid graph
    mermaid = generate_mermaid_coverage(coverage)

    return Diagram(
        type="test-coverage",
        format="mermaid",
        source={"mermaid": mermaid},
        references={
            "tests": [t.id for t in tests],
            "requirements": [r.id for r in requirements]
        }
    )

def generate_mermaid_coverage(coverage: dict):
    """
    Example output:
    ```mermaid
    graph TD
        req001[req-001: PW markers] --> test001[parse_template_with_pw_markers]
        req001 --> test002[validate_pw_marker_extraction]
        req002[req-002: comparison] --> test003[compare_added_sections]
        req002 --> test004[compare_removed_sections]
    ```
    """
    lines = ["graph TD"]

    for req_id, test_list in coverage.items():
        req_node = f"{req_id}[{req_id}: {get_req_summary(req_id)}]"

        for test in test_list:
            test_node = f"{test.id}[{test.scenario}]"
            lines.append(f"    {req_node} --> {test_node}")

    return "\n".join(lines)
```

---

## Pattern 8: Schema Entities → Entity-Relationship Diagram

### Source Data

```python
schema = load_schema(app_schema_name)
entities = schema.entities
relationships = extract_relationships(schema)
```

### Transformation Algorithm

```python
def schema_to_erd_diagram(schema) -> Diagram:
    # 1. Extract entities and relationships
    entities = [(e.name, e.description) for e in schema.entities]
    relationships = []

    for entity in schema.entities:
        for field in entity.fields:
            if field.is_reference:
                relationships.append((entity.name, field.target_entity, field.name))

    # 2. Generate Mermaid ER diagram
    mermaid = generate_mermaid_erd(entities, relationships)

    return Diagram(
        type="entity-relationship",
        format="mermaid",
        source={"mermaid": mermaid},
        references={"schema": schema.name}
    )

def generate_mermaid_erd(entities, relationships):
    """
    Example output:
    ```mermaid
    erDiagram
        Template ||--o{ Section : contains
        Section ||--o{ Section : nested
        Section }o--|| PWStyle : has
        Contract ||--o{ Section : contains
    ```
    """
    lines = ["erDiagram"]

    for source, target, label in relationships:
        cardinality = infer_cardinality(label)
        lines.append(f"    {source} {cardinality} {target} : {label}")

    return "\n".join(lines)
```

---

## Domain-Agnostic Principles

All transformation patterns follow these principles:

1. **Evidence-Based**: Extract from source entities, never invent
2. **Opaque Field Flexibility**: Use opaque `details`, `inputs`, `outputs` for domain-specific content
3. **Cross-Layer Validation**: Verify references exist before documenting
4. **Traceability**: Link back to source entities via `references` field
5. **Domain-Agnostic Templates**: Structure applies to documents, pipelines, web apps
6. **Markdown Output**: Generate human-readable markdown for all text docs
7. **Mermaid Diagrams**: Generate standardized Mermaid for all visual docs

These patterns enable the documentor skill to work across any domain while maintaining consistent quality and structure.
