# Skill Composition Guide: Integrating External Skills

## Overview

The documentor skill composes with other skills to generate rich, interactive documentation. Composition follows a **delegation pattern**: gather data, invoke skill, integrate result.

---

## Primary Composition: artifacts-builder

### Purpose

Generate interactive HTML artifacts for provenance visualization showing the full Layer 1 → 2 → 2.5 → 2.7 chain.

### When to Invoke

- User requests "provenance" documentation type
- User asks for "full chain" or "traceability visualization"
- Generating comprehensive documentation (all types)

### Invocation Pattern

```
Skill: artifacts-builder

Generate an interactive HTML artifact visualizing the full provenance chain for the [app-name] application built through the app-builder system.

**Requirements**:
- Interactive exploration: click through relationships
- Visual hierarchy: show layers clearly (Discovery → Schema → Implementation → Documentation)
- Relationship traversal: navigate from requirements to modules to interfaces to tests to docs
- Rich context: hover for details, expand for full content
- Smooth UX: modern design, intuitive navigation

**Data to visualize**:

[Insert gathered provenance data]

**Layer 1: Discovery**
- Problem Statement: [description]
- Requirements: [list with IDs and descriptions]
- Acceptance Criteria: [per requirement]

**Layer 2: Schema**
- Schema Name: [name]
- Entities: [list with relationships]
- Key Patterns: [domain patterns]

**Layer 2.5: Implementation Spec**
- Modules: [list with purposes and categories]
- Interfaces: [list with signatures]
- Tests: [list with scenarios]
- Dependencies: [module dependency graph]

**Layer 2.7: Documentation**
- Generated Docs: [list of DocumentEntity titles]
- Diagrams: [list of Diagram types]
- Coverage: [percentage metrics]

**Traceability**:
- Requirement req-001 → Module template-parser → Interface parse_template → Test parse_template_with_pw_markers → Doc "Template Parser Implementation Guide"
- [Additional chains...]

Generate a React-based interactive visualization that allows exploring these relationships dynamically.
```

### Data Gathering

```python
def gather_provenance_data(doc_session: DocumentationSession) -> dict:
    """
    Collect data from all layers for provenance visualization.
    """
    provenance = {}

    # Layer 1: Discovery (optional)
    if doc_session.discoverySession:
        discovery = wavesmith.store_get("DiscoverySession", doc_session.discoverySession)
        provenance["layer1"] = {
            "problem": discovery.problemStatement.description,
            "requirements": [
                {"id": r.id, "description": r.description, "criteria": r.acceptanceCriteria}
                for r in discovery.requirements
            ]
        }
    else:
        provenance["layer1"] = None

    # Layer 2: Schema
    schema = wavesmith.schema_get(doc_session.appSchemaName)
    provenance["layer2"] = {
        "name": doc_session.appSchemaName,
        "entities": extract_schema_entities(schema),
        "relationships": extract_schema_relationships(schema)
    }

    # Layer 2.5: Implementation Spec
    impl_session = wavesmith.store_get("ImplementationSession", doc_session.implementationSession)
    modules = [wavesmith.store_get("ModuleSpecification", m_id) for m_id in impl_session.modules]

    provenance["layer2.5"] = {
        "modules": [
            {
                "id": m.id,
                "name": m.name,
                "purpose": m.purpose,
                "category": m.category,
                "implements": [r.id for r in m.implementsRequirements]
            }
            for m in modules
        ],
        "interfaces": [
            {
                "id": i.id,
                "module": i.module,
                "name": i.functionName,
                "purpose": i.purpose
            }
            for m in modules for i in m.interfaces
        ],
        "tests": [
            {
                "id": t.id,
                "module": t.module,
                "scenario": t.scenario,
                "validates": t.validatesRequirement
            }
            for m in modules for t in m.tests
        ]
    }

    # Layer 2.7: Documentation
    docs = wavesmith.store_list("DocumentEntity", {"session": doc_session.id})
    diagrams = wavesmith.store_list("Diagram", {"session": doc_session.id})

    provenance["layer2.7"] = {
        "documents": [{"id": d.id, "type": d.type, "title": d.title} for d in docs],
        "diagrams": [{"id": d.id, "type": d.type, "format": d.format} for d in diagrams]
    }

    # Traceability chains
    provenance["traceability"] = build_traceability_chains(provenance)

    return provenance


def build_traceability_chains(provenance: dict) -> list:
    """
    Build explicit traceability chains showing flow from requirements to documentation.

    Example chain:
    req-001 → template-parser → parse_template → parse_template_with_pw_markers → "Template Parser Guide"
    """
    chains = []

    if not provenance["layer1"]:
        return chains

    for req in provenance["layer1"]["requirements"]:
        # Find modules implementing this requirement
        implementing_modules = [
            m for m in provenance["layer2.5"]["modules"]
            if req["id"] in m["implements"]
        ]

        for module in implementing_modules:
            # Find interfaces for this module
            module_interfaces = [
                i for i in provenance["layer2.5"]["interfaces"]
                if i["module"] == module["id"]
            ]

            for interface in module_interfaces:
                # Find tests validating this requirement
                validating_tests = [
                    t for t in provenance["layer2.5"]["tests"]
                    if t["validates"] == req["id"] and t["module"] == module["id"]
                ]

                for test in validating_tests:
                    # Find docs for this module
                    module_docs = [
                        d for d in provenance["layer2.7"]["documents"]
                        if module["id"] in d.get("references", {}).get("modules", [])
                    ]

                    chains.append({
                        "requirement": req["id"],
                        "module": module["name"],
                        "interface": interface["name"],
                        "test": test["scenario"],
                        "docs": [d["title"] for d in module_docs]
                    })

    return chains
```

### Result Integration

```python
def integrate_provenance_artifact(artifact_html: str, doc_session: DocumentationSession) -> DocumentEntity:
    """
    Create DocumentEntity for provenance artifact returned by artifacts-builder.
    """
    return wavesmith.store_create("DocumentEntity", {
        "id": generate_id(),
        "session": doc_session.id,
        "type": "provenance",
        "title": "Full Provenance Chain",
        "content": {"html": artifact_html},
        "references": {
            "documentation_session": doc_session.id,
            "implementation_session": doc_session.implementationSession,
            "discovery_session": doc_session.discoverySession,
            "schema": doc_session.appSchemaName
        },
        "metadata": {"format": "interactive-html", "generated_by": "artifacts-builder"}
    })
```

### Error Handling

```python
def invoke_artifacts_builder_safe(provenance: dict) -> str:
    """
    Safely invoke artifacts-builder with error handling.
    """
    try:
        # Invoke skill
        result = invoke_skill("artifacts-builder", provenance_visualization_prompt(provenance))

        # Validate result is HTML
        if not result.startswith("<!DOCTYPE") and not result.startswith("<html"):
            raise ValueError("artifacts-builder did not return valid HTML")

        return result

    except Exception as e:
        # Fallback: generate simple HTML visualization
        warn(f"artifacts-builder invocation failed: {e}")
        warn("Generating fallback provenance visualization")
        return generate_fallback_provenance_html(provenance)


def generate_fallback_provenance_html(provenance: dict) -> str:
    """
    Generate simple HTML visualization if artifacts-builder fails.
    """
    html = """
    <!DOCTYPE html>
    <html>
    <head>
        <title>Provenance Chain</title>
        <style>
            body { font-family: sans-serif; padding: 20px; }
            .layer { margin: 20px 0; padding: 15px; border-left: 4px solid #007bff; }
            .layer h2 { margin-top: 0; }
            .chain { margin: 10px 0; padding: 10px; background: #f8f9fa; }
        </style>
    </head>
    <body>
        <h1>Provenance Chain</h1>
    """

    # Add layers
    for layer_name, layer_data in provenance.items():
        if layer_data:
            html += f"<div class='layer'><h2>{layer_name}</h2>"
            html += format_layer_html(layer_data)
            html += "</div>"

    html += "</body></html>"
    return html
```

---

## Secondary Compositions

### knowledge-scout (Discovery)

**Purpose**: Efficiently load discovery context when user provides discovery session name instead of ID.

**When to Invoke**:
- User says "document the contract-template-updater" without providing session IDs
- Need to find existing discovery session by name

**Pattern**:
```
Task: knowledge-scout

Find the discovery session for "contract-template-updater" in the Wavesmith graph.

Search for:
- Entity type: DiscoverySession
- Match: name contains "contract-template-updater"

Return the session ID.
```

### knowledge-scribe (Post-Generation)

**Purpose**: Optionally preserve generated documentation in Obsidian vault.

**When to Invoke**:
- User explicitly requests "save these docs to the vault"
- Documentation is reusable across projects
- Patterns documented are worth preserving

**Pattern**:
```
Task: knowledge-scribe

Evaluate whether this documentation should be preserved in the Obsidian vault:

**Documentation**:
- Type: Implementation guides for contract-template-updater
- Domain: Document processing with PracticeWorks patterns
- Reusability: High (pattern applies to similar document systems)

If worthy of preservation:
- Create guide in vault under Architecture/Contract-Processing/
- Link to related documentation
- Tag with relevant patterns

Otherwise, keep as session-specific Wavesmith entities.
```

**Note**: Do not invoke automatically. Let user decide if docs should be permanent.

---

## Composition Best Practices

### 1. Clear Delegation

Each composed skill has a single, focused responsibility:
- **artifacts-builder**: Generate rich interactive HTML
- **knowledge-scout**: Find entities quickly
- **knowledge-scribe**: Evaluate and preserve knowledge

Don't overlap responsibilities.

### 2. Data Preparation

Always prepare data **before** invoking:
- Gather all context needed
- Format data clearly
- Validate references exist

Don't make composed skills do data gathering.

### 3. Error Handling

Always have fallbacks:
- artifacts-builder fails → Generate simple HTML
- knowledge-scout fails → Ask user for session ID
- knowledge-scribe unavailable → Skip preservation

Don't fail the entire workflow if a composed skill has issues.

### 4. Result Validation

Verify composed skill output:
- artifacts-builder returns HTML → Check format
- knowledge-scout returns ID → Validate entity exists
- knowledge-scribe creates file → Verify in vault

Don't blindly trust composed skill results.

### 5. Transparent Invocation

Tell user when composing:
- "Generating interactive provenance visualization using artifacts-builder..."
- "Searching for discovery session using knowledge-scout..."
- "Preserving documentation to vault using knowledge-scribe..."

Don't silently invoke skills.

---

## Provenance Artifact Specifications

### Required Features

The artifacts-builder provenance visualization must include:

1. **Visual Layer Hierarchy**
   - Clear separation of L1 (Discovery), L2 (Schema), L2.5 (Spec), L2.7 (Docs)
   - Visual flow from top (problem) to bottom (documentation)

2. **Interactive Navigation**
   - Click requirement → see implementing modules
   - Click module → see interfaces and tests
   - Click interface → see API documentation
   - Click test → see test documentation

3. **Relationship Visualization**
   - Lines connecting related entities
   - Color coding by type (requirement, module, interface, test, doc)
   - Hover to see connection details

4. **Context Panels**
   - Click entity → panel opens with full details
   - Requirements show acceptance criteria
   - Modules show purpose and algorithm details
   - Interfaces show inputs/outputs
   - Tests show Given/When/Then

5. **Search and Filter**
   - Search by entity name or description
   - Filter by layer (show only L2.5, etc.)
   - Filter by type (show only tests, etc.)

6. **Export Options**
   - Export as standalone HTML
   - Print-friendly view
   - Share link (if hosted)

### Example Structure

```html
<!DOCTYPE html>
<html>
<head>
    <title>Provenance: contract-template-updater</title>
    <!-- React, D3.js, or similar for interactivity -->
</head>
<body>
    <div id="provenance-app">
        <header>
            <h1>Provenance Chain</h1>
            <nav>Layers: [L1] [L2] [L2.5] [L2.7]</nav>
            <search>
                <input placeholder="Search entities..." />
            </search>
        </header>

        <main>
            <!-- Interactive graph visualization -->
            <svg id="provenance-graph">
                <!-- Nodes and edges rendered here -->
            </svg>

            <!-- Detail panel (slides in on click) -->
            <aside id="detail-panel">
                <!-- Entity details rendered here -->
            </aside>
        </main>

        <footer>
            <button>Export HTML</button>
            <button>Print View</button>
        </footer>
    </div>

    <script>
        // Interactive provenance visualization logic
    </script>
</body>
</html>
```

---

## Composition Workflow Summary

```
Phase 3: Synthesis (when provenance requested)
  ↓
1. Gather provenance data from all layers
  ↓
2. Build traceability chains
  ↓
3. Invoke artifacts-builder skill
  ↓
4. Validate returned HTML
  ↓
5. Create DocumentEntity with HTML content
  ↓
6. Continue with other documentation types
```

**Time budget**: artifacts-builder invocation should complete within 2-3 minutes for typical complexity.

---

**Skill composition enables rich, interactive documentation while maintaining clean separation of concerns. Each skill does what it does best.**
