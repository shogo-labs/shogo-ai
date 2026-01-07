/**
 * RenderingDemoPage - Proof-of-work demo for Component Registry
 * Task: task-demo-page
 *
 * Demonstrates:
 * - PropertyRenderer with various property types
 * - Format-specific rendering (email, uri, date-time)
 * - Enum badge rendering
 * - ReferenceDisplay with resolved entity
 * - ComputedDisplay styling
 * - ArrayDisplay with nested items
 * - x-renderer explicit override
 * - Cascade resolution priority
 */

import { observer } from "mobx-react-lite"
import {
  ComponentRegistryProvider,
  PropertyRenderer,
  createDefaultRegistry,
  StringDisplay,
  type PropertyMetadata,
  type DisplayRendererProps
} from "../components/rendering"

// Custom renderer for x-renderer demo
const PriorityBadge = ({ value }: DisplayRendererProps) => {
  const priority = String(value).toLowerCase()
  const colors = {
    high: "bg-red-500 text-white",
    medium: "bg-yellow-500 text-black",
    low: "bg-green-500 text-white"
  }
  const colorClass = colors[priority as keyof typeof colors] || "bg-gray-500 text-white"

  return (
    <span className={`px-3 py-1 rounded-full text-sm font-bold ${colorClass}`}>
      {String(value).toUpperCase()}
    </span>
  )
}

// Create registry with custom renderer
const registry = createDefaultRegistry()
registry.register({
  id: "priority-badge",
  matches: (meta) => meta.xRenderer === "priority-badge",
  component: PriorityBadge,
  priority: 200
})

// Demo data
const demoSections = [
  {
    title: "Primitive Types",
    items: [
      {
        label: "String",
        property: { name: "name", type: "string" } as PropertyMetadata,
        value: "John Doe"
      },
      {
        label: "Number",
        property: { name: "count", type: "number" } as PropertyMetadata,
        value: 1234567
      },
      {
        label: "Boolean (true)",
        property: { name: "active", type: "boolean" } as PropertyMetadata,
        value: true
      },
      {
        label: "Boolean (false)",
        property: { name: "inactive", type: "boolean" } as PropertyMetadata,
        value: false
      }
    ]
  },
  {
    title: "Format-Specific",
    items: [
      {
        label: "Email",
        property: { name: "email", type: "string", format: "email" } as PropertyMetadata,
        value: "contact@example.com"
      },
      {
        label: "URI",
        property: { name: "website", type: "string", format: "uri" } as PropertyMetadata,
        value: "https://github.com/shogo-ai"
      },
      {
        label: "Date-Time",
        property: { name: "createdAt", type: "string", format: "date-time" } as PropertyMetadata,
        value: "2024-01-15T10:30:00Z"
      }
    ]
  },
  {
    title: "Enum Values",
    items: [
      {
        label: "Status (active)",
        property: { name: "status", type: "string", enum: ["active", "inactive", "pending"] } as PropertyMetadata,
        value: "active"
      },
      {
        label: "Status (pending)",
        property: { name: "status", type: "string", enum: ["active", "inactive", "pending"] } as PropertyMetadata,
        value: "pending"
      },
      {
        label: "Status (inactive)",
        property: { name: "status", type: "string", enum: ["active", "inactive", "pending"] } as PropertyMetadata,
        value: "inactive"
      }
    ]
  },
  {
    title: "Reference Display",
    items: [
      {
        label: "Resolved Reference",
        property: { name: "author", type: "string", xReferenceType: "single", xReferenceTarget: "User" } as PropertyMetadata,
        value: "user-123",
        entity: { id: "user-123", name: "Alice Smith", email: "alice@example.com" }
      },
      {
        label: "Reference (title cascade)",
        property: { name: "project", type: "string", xReferenceType: "single" } as PropertyMetadata,
        value: "proj-456",
        entity: { id: "proj-456", title: "Shogo AI Platform" }
      },
      {
        label: "Unresolved Reference",
        property: { name: "stale", type: "string", xReferenceType: "single" } as PropertyMetadata,
        value: "missing-ref-789",
        entity: undefined
      }
    ]
  },
  {
    title: "Computed Values",
    items: [
      {
        label: "Computed Count",
        property: { name: "totalCount", type: "number", xComputed: true } as PropertyMetadata,
        value: 42
      },
      {
        label: "Computed String",
        property: { name: "fullName", type: "string", xComputed: true } as PropertyMetadata,
        value: "John Doe Jr."
      }
    ]
  },
  {
    title: "Collections",
    items: [
      {
        label: "Array of strings",
        property: { name: "tags", type: "array" } as PropertyMetadata,
        value: ["react", "typescript", "mobx-state-tree", "schema-driven"]
      },
      {
        label: "Empty array",
        property: { name: "empty", type: "array" } as PropertyMetadata,
        value: []
      },
      {
        label: "Object",
        property: { name: "config", type: "object" } as PropertyMetadata,
        value: { theme: "dark", language: "en", notifications: true }
      }
    ]
  },
  {
    title: "x-renderer Override",
    items: [
      {
        label: "Priority Badge (x-renderer)",
        property: { name: "priority", type: "string", xRenderer: "priority-badge" } as PropertyMetadata,
        value: "high"
      },
      {
        label: "Priority Badge (medium)",
        property: { name: "priority", type: "string", xRenderer: "priority-badge" } as PropertyMetadata,
        value: "medium"
      },
      {
        label: "Priority Badge (low)",
        property: { name: "priority", type: "string", xRenderer: "priority-badge" } as PropertyMetadata,
        value: "low"
      }
    ]
  },
  {
    title: "Cascade Priority Demo",
    description: "Shows how cascade resolution prioritizes: xRenderer > xComputed > enum > format > type",
    items: [
      {
        label: "String with email format → EmailDisplay",
        property: { name: "email", type: "string", format: "email" } as PropertyMetadata,
        value: "test@test.com"
      },
      {
        label: "String with enum → EnumBadge (beats format)",
        property: { name: "status", type: "string", format: "email", enum: ["active", "inactive"] } as PropertyMetadata,
        value: "active"
      },
      {
        label: "Computed string → ComputedDisplay (beats enum)",
        property: { name: "derived", type: "string", enum: ["a", "b"], xComputed: true } as PropertyMetadata,
        value: "computed-value"
      },
      {
        label: "x-renderer beats everything",
        property: { name: "override", type: "string", format: "email", enum: ["a"], xComputed: true, xRenderer: "priority-badge" } as PropertyMetadata,
        value: "high"
      }
    ]
  },
  {
    title: "Edge Cases",
    items: [
      {
        label: "Null value",
        property: { name: "nullable", type: "string" } as PropertyMetadata,
        value: null
      },
      {
        label: "Undefined value",
        property: { name: "undef", type: "number" } as PropertyMetadata,
        value: undefined
      },
      {
        label: "Long text (truncated)",
        property: { name: "description", type: "string" } as PropertyMetadata,
        value: "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur."
      }
    ]
  }
]

export const RenderingDemoPage = observer(function RenderingDemoPage() {
  return (
    <ComponentRegistryProvider registry={registry}>
      <div className="min-h-screen bg-background text-foreground p-8">
        <div className="max-w-4xl mx-auto">
          <header className="mb-8">
            <h1 className="text-3xl font-bold mb-2">Component Registry Demo</h1>
            <p className="text-muted-foreground">
              Schema-aware dynamic component system for React.
              Renders UI from Enhanced JSON Schema metadata.
            </p>
          </header>

          {demoSections.map((section) => (
            <section key={section.title} className="mb-8">
              <h2 className="text-xl font-semibold mb-2 text-foreground">
                {section.title}
              </h2>
              {section.description && (
                <p className="text-sm text-muted-foreground mb-4">
                  {section.description}
                </p>
              )}
              <div className="bg-card rounded-lg border border-border overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border bg-muted/50">
                      <th className="text-left p-3 text-sm font-medium text-muted-foreground">
                        Property
                      </th>
                      <th className="text-left p-3 text-sm font-medium text-muted-foreground">
                        Rendered Value
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {section.items.map((item, index) => (
                      <tr
                        key={index}
                        className="border-b border-border last:border-b-0"
                      >
                        <td className="p-3">
                          <div className="text-sm font-medium text-foreground">
                            {item.label}
                          </div>
                          <code className="text-xs text-muted-foreground">
                            {JSON.stringify(item.property, null, 0)}
                          </code>
                        </td>
                        <td className="p-3">
                          <PropertyRenderer
                            property={item.property}
                            value={item.value}
                            entity={(item as any).entity}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}

          <footer className="mt-12 pt-8 border-t border-border text-center text-sm text-muted-foreground">
            <p>
              Task: task-demo-page | Session: component-builder-display
            </p>
          </footer>
        </div>
      </div>
    </ComponentRegistryProvider>
  )
})

export default RenderingDemoPage
