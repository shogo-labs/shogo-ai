/**
 * ReferenceDisplay - Shows resolved entity with name/title/id cascade
 * Task: task-display-renderers
 *
 * Uses MST auto-resolution - when entity is provided, displays the resolved
 * entity's name > title > email > id (first found).
 * When entity is not resolved, shows the raw ID value.
 */

import { observer } from "mobx-react-lite"
import type { DisplayRendererProps } from "../types"

/**
 * Extracts display text from an entity using cascade:
 * name > title > email > id > value
 */
function getEntityDisplayText(entity: any, value: any): string {
  if (entity && typeof entity === "object") {
    if (entity.name) return entity.name
    if (entity.title) return entity.title
    if (entity.email) return entity.email
    if (entity.id) return entity.id
  }
  // Fallback to raw value
  return value != null ? String(value) : "-"
}

export const ReferenceDisplay = observer(function ReferenceDisplay({
  value,
  entity
}: DisplayRendererProps) {
  if (value == null && entity == null) {
    return <span className="text-muted-foreground">-</span>
  }

  const displayText = getEntityDisplayText(entity, value)
  const isUnresolved = !entity || typeof entity !== "object"

  return (
    <span
      className={`inline-flex items-center gap-1 ${
        isUnresolved ? "text-muted-foreground italic" : "text-foreground"
      }`}
      title={isUnresolved ? `Unresolved: ${value}` : undefined}
    >
      {isUnresolved && (
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
          />
        </svg>
      )}
      {displayText}
    </span>
  )
})
