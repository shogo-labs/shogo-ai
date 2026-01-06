/**
 * Default Component Registry Configuration
 * Task: task-demo-page
 *
 * Pre-configured registry with all display renderers and standard cascade priorities.
 */

import { createComponentRegistry, type ComponentRegistryConfig } from "./ComponentRegistry"
import {
  StringDisplay,
  NumberDisplay,
  BooleanDisplay,
  DateTimeDisplay,
  EmailDisplay,
  UriDisplay,
  EnumBadge,
  ReferenceDisplay,
  ComputedDisplay,
  ArrayDisplay,
  ObjectDisplay
} from "./displays"

/**
 * Creates a registry with all default display renderers.
 *
 * Priority cascade:
 * 1. xRenderer explicit (200)
 * 2. xComputed (100)
 * 3. xReferenceType single (100)
 * 4. xReferenceType array (100)
 * 5. enum (50)
 * 6. format: date-time (30)
 * 7. format: email (30)
 * 8. format: uri (30)
 * 9. type: string (10)
 * 10. type: number (10)
 * 11. type: boolean (10)
 * 12. type: array (10)
 * 13. type: object (10)
 * 14. fallback: StringDisplay (0)
 */
export function createDefaultRegistry() {
  return createComponentRegistry({
    defaultComponent: StringDisplay,
    entries: [
      // xComputed - highest priority for computed fields
      {
        id: "computed-display",
        matches: (meta) => meta.xComputed === true,
        component: ComputedDisplay,
        priority: 100
      },

      // xReferenceType single
      {
        id: "reference-display",
        matches: (meta) => meta.xReferenceType === "single",
        component: ReferenceDisplay,
        priority: 100
      },

      // xReferenceType array
      {
        id: "reference-array-display",
        matches: (meta) => meta.xReferenceType === "array",
        component: ArrayDisplay,
        priority: 100
      },

      // enum
      {
        id: "enum-badge",
        matches: (meta) => Array.isArray(meta.enum) && meta.enum.length > 0,
        component: EnumBadge,
        priority: 50
      },

      // format: date-time
      {
        id: "datetime-display",
        matches: (meta) => meta.format === "date-time",
        component: DateTimeDisplay,
        priority: 30
      },

      // format: email
      {
        id: "email-display",
        matches: (meta) => meta.format === "email",
        component: EmailDisplay,
        priority: 30
      },

      // format: uri
      {
        id: "uri-display",
        matches: (meta) => meta.format === "uri",
        component: UriDisplay,
        priority: 30
      },

      // type: number
      {
        id: "number-display",
        matches: (meta) => meta.type === "number",
        component: NumberDisplay,
        priority: 10
      },

      // type: boolean
      {
        id: "boolean-display",
        matches: (meta) => meta.type === "boolean",
        component: BooleanDisplay,
        priority: 10
      },

      // type: array
      {
        id: "array-display",
        matches: (meta) => meta.type === "array",
        component: ArrayDisplay,
        priority: 10
      },

      // type: object
      {
        id: "object-display",
        matches: (meta) => meta.type === "object",
        component: ObjectDisplay,
        priority: 10
      },

      // type: string (lower priority, fallback after formats)
      {
        id: "string-display",
        matches: (meta) => meta.type === "string",
        component: StringDisplay,
        priority: 10
      }
    ]
  })
}
