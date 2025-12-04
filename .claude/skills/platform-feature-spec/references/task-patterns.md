# Task Patterns by Change Type

## Pattern: New Utility Module

**Integration points**: `changeType: "add"` for utility files

**Task structure**:
```
Description: Create {module} utilities
Acceptance Criteria:
- File exists at {path}
- Exports: {function1}, {function2}
- {function1} handles {happy path}
- {function1} handles {error case}
```

---

## Pattern: New MCP Tool

**Integration points**: `changeType: "add"` for tool files

**Task structure**:
```
Description: Implement {namespace}.{name} tool
Acceptance Criteria:
- Tool registered with correct name
- Accepts specified parameters
- Returns expected response shape
- Handles error cases appropriately
```

---

## Pattern: New React Context

**Integration points**: `changeType: "add"` for context files

**Task structure**:
```
Description: Create {Name}Context and Provider
Acceptance Criteria:
- Exports Provider and hook
- Provider initializes correctly
- Hook returns expected shape
- Hook throws outside Provider
```

---

## Pattern: New React Component/Page

**Integration points**: `changeType: "add"` for component/page files

**Task structure**:
```
Description: Create {ComponentName}
Acceptance Criteria:
- Renders key elements
- Handles user interactions
- Shows loading/error states
```

---

## Pattern: Modify Existing File

**Integration points**: `changeType: "modify"`

**Task structure**:
```
Description: Update {file} to {change summary}
Acceptance Criteria:
- New behavior works correctly
- Existing behavior unchanged
```

---

## Pattern: Extend Registry/Router

**Integration points**: `changeType: "extend"`

**Task structure**:
```
Description: Register {new items}
Acceptance Criteria:
- New item is accessible
- Existing items unaffected
```

---

## Pattern: Add Dependencies

**Integration points**: `changeType: "modify"` for package.json

**Task structure**:
```
Description: Add required dependencies
Acceptance Criteria:
- package.json updated
- Install succeeds
- Packages importable
```

---

## Dependency Ordering Principle

Dependencies flow: **infrastructure → utilities → core logic → integration → UI**

1. Package dependencies (no deps)
2. Utility modules (depend on packages)
3. Core implementations (depend on utilities)
4. Registration/wiring (depend on implementations)
5. UI components (depend on context/services)
