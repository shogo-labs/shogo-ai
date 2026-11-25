// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ModelShareDonut
 *
 * Ring chart of token share per model with a ranked legend beside it, like
 * Z Code's "model usage" panel. The ring itself is `ShareRing` (SHO-477) so
 * Desktop versions draws the same component with OS rows; colours match the
 * daily stacked chart so a model keeps one colour across both.
 */

import { useMemo } from 'react'
import { View } from 'react-native'
import { Text } from '../settings/account-sheet-chrome'
import { STACKED_PALETTE } from './StackedAreaChart'
import { ShareRing, type ShareRingRow } from './ShareRing'
import { compactNumber, seriesColor } from '../../lib/engagement-utils'

export interface ModelShareRow {
  model: string
  tokens: number
  pct: number
}

export function ModelShareDonut({ rows }: { rows: ModelShareRow[] }) {
  const shareRows = useMemo<ShareRingRow[]>(
    () =>
      rows.map((row, i) => ({
        id: row.model,
        label: row.model,
        value: row.tokens,
        pct: row.pct,
        color: seriesColor(row.model, i, STACKED_PALETTE),
      })),
    [rows],
  )

  const total = useMemo(() => rows.reduce((s, r) => s + r.tokens, 0), [rows])

  if (shareRows.length === 0 || !rows.some((row) => row.pct > 0)) {
    return (
      <View className="h-[132px] items-center justify-center">
        <Text className="text-sm text-muted-foreground">No model usage in this period</Text>
      </View>
    )
  }

  return (
    <ShareRing
      rows={shareRows}
      formatValue={compactNumber}
      center={{ value: compactNumber(total), caption: 'tokens' }}
    />
  )
}
