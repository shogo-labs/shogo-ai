# TDD-Lite for UI Components

Lightweight test-driven approach for view-builder components.

## Philosophy

Full TDD for every UI component is overkill. Instead:
- Write component first (from spec requirements)
- Verify key behaviors manually
- Add tests for complex logic only

## Verification Checklist

### 1. Build Verification

```bash
bun run build
```

**Must pass** - catches type errors, import issues.

### 2. Visual Verification

Open in browser and verify:
- [ ] Component renders without errors
- [ ] Empty state displays correctly
- [ ] With data, content matches expectations
- [ ] Layout matches layout decisions
- [ ] Styling is consistent with other sections

### 3. Props Contract

Verify component handles:
- [ ] Missing `feature` prop → shows empty state
- [ ] Missing data → shows "no data" message
- [ ] Config options work as documented

### 4. Console Check

Open browser DevTools Console:
- [ ] No React errors
- [ ] No MobX warnings
- [ ] No unhandled exceptions

## When to Write Tests

Add actual test files for:

### Complex Data Transformations

```typescript
// If component does grouping, filtering, or aggregation
describe("groupByStatus", () => {
  it("groups tasks correctly", () => {
    const tasks = [
      { id: "1", status: "pending" },
      { id: "2", status: "complete" },
      { id: "3", status: "pending" },
    ]
    const grouped = groupByStatus(tasks)
    expect(grouped.pending).toHaveLength(2)
    expect(grouped.complete).toHaveLength(1)
  })
})
```

### Conditional Rendering Logic

```typescript
// If component has complex conditional display
describe("shouldShowWarning", () => {
  it("returns true when deadline passed", () => {
    expect(shouldShowWarning({ deadline: Date.now() - 1000 })).toBe(true)
  })
})
```

### User Interaction Handlers

```typescript
// If component has non-trivial click/selection logic
describe("selection behavior", () => {
  it("toggles selection on click", () => {
    // Test selection state changes
  })
})
```

## Test File Location

If test needed, place at:
```
apps/web/src/components/rendering/sections/__tests__/{Name}Section.test.tsx
```

## Minimal Test Template

```typescript
import { render, screen } from "@testing-library/react"
import { {Name}Section } from "../{Name}Section"

// Mock useDomains if needed
jest.mock("@/contexts/DomainProvider", () => ({
  useDomains: () => ({
    {domain}: {
      {collection}: {
        {method}: () => [],
      },
    },
  }),
}))

describe("{Name}Section", () => {
  it("renders empty state without feature", () => {
    render(<{Name}Section />)
    expect(screen.getByText(/no feature session/i)).toBeInTheDocument()
  })
})
```

## Skip Tests For

- Pure display components with no logic
- Components that just map data to UI
- Simple wrappers around shadcn/ui components
- Compositions (tested via constituent sections)

## Document Verification

Even without tests, document what was verified:

```typescript
/**
 * {Name}Section Component
 *
 * Verification (TDD-lite):
 * - Build: passes
 * - Empty state: shows "No feature session" message
 * - With data: displays {expected content}
 * - Console: no errors
 *
 * Manual test: Visited /{route} in browser, verified {behavior}
 */
```

This documentation serves as lightweight test coverage evidence.
