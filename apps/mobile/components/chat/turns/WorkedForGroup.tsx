// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * WorkedForGroup Component (React Native)
 *
 * Thin wrapper around `CollapsibleToolGroup` for the turn-level
 * "Worked for X" header. Renders the work log (everything before the
 * turn's last text block — see `partitionTurn` in `turnShaping.ts`)
 * collapsed by default with the completed duration; falls back to a
 * count-only "Worked · edited N files, ran N commands" label for
 * messages persisted before turn timing was recorded.
 *
 * When there's no body to expand (`hasBody === false` — the last text
 * block was the very first part), renders as a static row with no
 * chevron per the spec: "the header still renders with the time but
 * has nothing to expand".
 */

import { memo, type ReactNode } from "react"
import { CollapsibleToolGroup } from "./CollapsibleToolGroup"
import { formatWorkedDuration } from "./turnShaping"

export interface WorkedForGroupProps {
  startedAt?: number
  completedAt?: number
  /** Count-only label used when `startedAt`/`completedAt` aren't both available. */
  fallbackLabel: string
  isExpanded?: boolean
  onToggle?: () => void
  hasBody: boolean
  children: ReactNode
}

function buildLabel(startedAt: number | undefined, completedAt: number | undefined, fallbackLabel: string): string {
  if (startedAt !== undefined && completedAt !== undefined && completedAt >= startedAt) {
    return `Worked for ${formatWorkedDuration(completedAt - startedAt)}`
  }
  return fallbackLabel
}

function WorkedForGroupImpl({
  startedAt,
  completedAt,
  fallbackLabel,
  isExpanded,
  onToggle,
  hasBody,
  children,
}: WorkedForGroupProps) {
  const label = buildLabel(startedAt, completedAt, fallbackLabel)

  if (!hasBody) {
    return (
      <CollapsibleToolGroup label={label} isStreaming={false} contentKey="worked-for-content" disabled>
        {null}
      </CollapsibleToolGroup>
    )
  }

  return (
    <CollapsibleToolGroup
      label={label}
      isStreaming={false}
      isExpanded={isExpanded}
      onToggle={onToggle}
      contentKey="worked-for-content"
    >
      {children}
    </CollapsibleToolGroup>
  )
}

export const WorkedForGroup = memo(WorkedForGroupImpl)

export default WorkedForGroup
