/**
 * ArrayDisplay - Shows item count with expandable list
 * Task: task-display-renderers
 *
 * Respects depth limit (max 2) to prevent infinite recursion.
 */

import { observer } from "mobx-react-lite"
import { useState } from "react"
import type { DisplayRendererProps } from "../types"

const MAX_DEPTH = 2
const MAX_ITEMS_COLLAPSED = 3

export const ArrayDisplay = observer(function ArrayDisplay({
  value,
  depth = 0
}: DisplayRendererProps) {
  const [expanded, setExpanded] = useState(false)

  if (value == null) {
    return <span className="text-muted-foreground">-</span>
  }

  if (!Array.isArray(value)) {
    return <span className="text-muted-foreground">[Invalid array]</span>
  }

  const count = value.length

  if (count === 0) {
    return <span className="text-muted-foreground">0 items</span>
  }

  // At max depth, just show count
  if (depth >= MAX_DEPTH) {
    return (
      <span className="text-muted-foreground">
        [{count} items...]
      </span>
    )
  }

  const itemsToShow = expanded ? value : value.slice(0, MAX_ITEMS_COLLAPSED)
  const hasMore = count > MAX_ITEMS_COLLAPSED

  return (
    <div className="inline-block">
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-primary hover:underline text-sm"
      >
        {count} items {expanded ? "[-]" : "[+]"}
      </button>
      {expanded && (
        <ul className="ml-4 mt-1 space-y-1 text-sm">
          {itemsToShow.map((item, index) => (
            <li key={index} className="text-foreground">
              <span className="text-muted-foreground mr-2">{index}:</span>
              {renderItem(item, depth + 1)}
            </li>
          ))}
          {hasMore && !expanded && (
            <li className="text-muted-foreground">
              ...and {count - MAX_ITEMS_COLLAPSED} more
            </li>
          )}
        </ul>
      )}
    </div>
  )
})

function renderItem(item: any, depth: number): React.ReactNode {
  if (item == null) {
    return <span className="text-muted-foreground">null</span>
  }

  if (typeof item === "object") {
    if (Array.isArray(item)) {
      if (depth >= MAX_DEPTH) {
        return <span className="text-muted-foreground">[{item.length} items...]</span>
      }
      return <span className="text-muted-foreground">[Array: {item.length}]</span>
    }
    if (depth >= MAX_DEPTH) {
      return <span className="text-muted-foreground">{"{...}"}</span>
    }
    const keys = Object.keys(item)
    return <span className="text-muted-foreground">{`{${keys.slice(0, 3).join(", ")}${keys.length > 3 ? "..." : ""}}`}</span>
  }

  return <span>{String(item)}</span>
}
