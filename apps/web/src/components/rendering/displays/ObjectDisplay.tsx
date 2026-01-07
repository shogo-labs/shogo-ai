/**
 * ObjectDisplay - Shows key-value pairs with depth limit
 * Task: task-display-renderers
 *
 * Respects depth limit (max 2) to prevent infinite recursion.
 */

import { observer } from "mobx-react-lite"
import { useState } from "react"
import type { DisplayRendererProps } from "../types"

const MAX_DEPTH = 2
const MAX_KEYS_COLLAPSED = 3

export const ObjectDisplay = observer(function ObjectDisplay({
  value,
  depth = 0
}: DisplayRendererProps) {
  const [expanded, setExpanded] = useState(false)

  if (value == null) {
    return <span className="text-muted-foreground">-</span>
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    return <span className="text-muted-foreground">{String(value)}</span>
  }

  const entries = Object.entries(value)
  const count = entries.length

  if (count === 0) {
    return <span className="text-muted-foreground">{"{empty}"}</span>
  }

  // At max depth, just show summary
  if (depth >= MAX_DEPTH) {
    return (
      <span className="text-muted-foreground">
        {`{${count} keys...}`}
      </span>
    )
  }

  const entriesToShow = expanded ? entries : entries.slice(0, MAX_KEYS_COLLAPSED)
  const hasMore = count > MAX_KEYS_COLLAPSED

  return (
    <div className="inline-block">
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-primary hover:underline text-sm"
      >
        {count} keys {expanded ? "[-]" : "[+]"}
      </button>
      {expanded && (
        <dl className="ml-4 mt-1 space-y-1 text-sm">
          {entriesToShow.map(([key, val]) => (
            <div key={key} className="flex gap-2">
              <dt className="text-muted-foreground font-medium">{key}:</dt>
              <dd className="text-foreground">{renderValue(val, depth + 1)}</dd>
            </div>
          ))}
          {hasMore && !expanded && (
            <div className="text-muted-foreground">
              ...and {count - MAX_KEYS_COLLAPSED} more keys
            </div>
          )}
        </dl>
      )}
    </div>
  )
})

function renderValue(val: any, depth: number): React.ReactNode {
  if (val == null) {
    return <span className="text-muted-foreground">null</span>
  }

  if (typeof val === "object") {
    if (Array.isArray(val)) {
      if (depth >= MAX_DEPTH) {
        return <span className="text-muted-foreground">[{val.length} items...]</span>
      }
      return <span className="text-muted-foreground">[Array: {val.length}]</span>
    }
    if (depth >= MAX_DEPTH) {
      return <span className="text-muted-foreground">{"{...}"}</span>
    }
    const keys = Object.keys(val)
    return <span className="text-muted-foreground">{`{${keys.slice(0, 3).join(", ")}${keys.length > 3 ? "..." : ""}}`}</span>
  }

  if (typeof val === "boolean") {
    return <span className={val ? "text-green-600" : "text-red-600"}>{String(val)}</span>
  }

  if (typeof val === "number") {
    return <span className="tabular-nums">{val.toLocaleString()}</span>
  }

  return <span>{String(val)}</span>
}
