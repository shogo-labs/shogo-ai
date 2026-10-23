// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * How each board sorts its cards (Newest / Oldest / Manual), remembered per
 * board on this device. No saved value means Newest. Lightweight,
 * AsyncStorage-backed — same shape as lib/notifications/preferences.ts.
 */

import { useCallback, useEffect, useState } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { DEFAULT_BOARD_SORT, type BoardSort } from './board-layout'

const PREFIX = 'shogo:board-sort:'

const memory = new Map<string, BoardSort>()
const loading = new Map<string, Promise<BoardSort>>()

export function isBoardSort(value: unknown): value is BoardSort {
  return value === 'newest' || value === 'oldest' || value === 'manual'
}

/** The board's sort from this session, or Newest before it has loaded. */
export function getBoardSort(boardId: string): BoardSort {
  return memory.get(boardId) ?? DEFAULT_BOARD_SORT
}

export function loadBoardSort(boardId: string): Promise<BoardSort> {
  const cached = memory.get(boardId)
  if (cached) return Promise.resolve(cached)
  const inFlight = loading.get(boardId)
  if (inFlight) return inFlight
  const read = AsyncStorage.getItem(PREFIX + boardId)
    .then((raw) => {
      const sort = isBoardSort(raw) ? raw : DEFAULT_BOARD_SORT
      memory.set(boardId, sort)
      return sort
    })
    .catch(() => DEFAULT_BOARD_SORT)
    .finally(() => {
      loading.delete(boardId)
    })
  loading.set(boardId, read)
  return read
}

export async function setBoardSort(boardId: string, sort: BoardSort): Promise<void> {
  memory.set(boardId, sort)
  try {
    await AsyncStorage.setItem(PREFIX + boardId, sort)
  } catch {
    // ignore persistence errors
  }
}

export function useBoardSort(boardId: string): [BoardSort, (sort: BoardSort) => void] {
  const [sort, setSort] = useState<BoardSort>(() => getBoardSort(boardId))
  useEffect(() => {
    let mounted = true
    setSort(getBoardSort(boardId))
    void loadBoardSort(boardId).then((saved) => {
      if (mounted) setSort(saved)
    })
    return () => {
      mounted = false
    }
  }, [boardId])
  const choose = useCallback(
    (next: BoardSort) => {
      setSort(next)
      void setBoardSort(boardId, next)
    },
    [boardId],
  )
  return [sort, choose]
}
