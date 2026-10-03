// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Searchable emoji picker: recently used, the workspace's custom emoji, then
 * every Unicode emoji by category. Picks are `:name:` for custom emoji and
 * the character itself otherwise.
 */
import { useMemo, useRef, useState } from 'react'
import { FlatList, Image, Platform, Pressable, Text, TextInput, View } from 'react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { EMOJI_GROUPS, searchEmoji } from '../../lib/emoji-data'
import { useCustomEmoji } from '../../hooks/useCustomEmoji'

const COLS = 8
const CELL = 36
const HEADER = 26
const RECENT_MAX = 16
const DEFAULT_RECENT = ['👍', '✅', '👀', '🎉', '❤️', '😂', '🙏', '🔥']

let recent: string[] = []

/** Remember a pick so it leads the picker next time. */
export function rememberEmoji(code: string): void {
  recent = [code, ...recent.filter((c) => c !== code)].slice(0, RECENT_MAX)
}

interface Cell {
  code: string
  label: string
  imageUrl?: string
}

type Item = { kind: 'header'; key: string; title: string } | { kind: 'row'; key: string; cells: Cell[] }

function chunk(cells: Cell[], prefix: string): Item[] {
  const rows: Item[] = []
  for (let i = 0; i < cells.length; i += COLS) rows.push({ kind: 'row', key: `${prefix}-${i}`, cells: cells.slice(i, i + COLS) })
  return rows
}

export interface EmojiPickerProps {
  workspaceId?: string | null
  onPick: (code: string) => void
  className?: string
}

export function EmojiPicker({ workspaceId, onPick, className }: EmojiPickerProps) {
  const [query, setQuery] = useState('')
  const custom = useCustomEmoji(workspaceId)
  const listRef = useRef<FlatList<Item>>(null)

  const { items, sectionStarts } = useMemo(() => {
    const customCells: Cell[] = [...custom.values()].map((e) => ({ code: `:${e.name}:`, label: `:${e.name}:`, imageUrl: e.url }))
    const q = query.trim().toLowerCase()
    if (q) {
      const cells: Cell[] = [
        ...customCells.filter((c) => c.code.includes(q.replace(/:/g, ''))),
        ...searchEmoji(q, 120).map((e) => ({ code: e.emoji, label: e.name })),
      ]
      return { items: chunk(cells, 'search'), sectionStarts: [] as Array<{ title: string; icon: string; index: number }> }
    }
    const out: Item[] = []
    const starts: Array<{ title: string; icon: string; index: number }> = []
    const section = (title: string, icon: string, cells: Cell[]) => {
      if (!cells.length) return
      starts.push({ title, icon, index: out.length })
      out.push({ kind: 'header', key: `h-${title}`, title })
      out.push(...chunk(cells, title))
    }
    const recentCodes = recent.length ? recent : DEFAULT_RECENT
    section('Frequently used', '🕘', recentCodes.map((code) => {
      const c = customCells.find((x) => x.code === code)
      return c ?? { code, label: code }
    }))
    section('Custom', '⭐', customCells)
    for (const g of EMOJI_GROUPS) section(g.name, g.emojis[0]?.emoji ?? '•', g.emojis.map((e) => ({ code: e.emoji, label: e.name })))
    return { items: out, sectionStarts: starts }
  }, [custom, query])
  const offsets = useMemo(() => {
    const out: number[] = []
    let at = 0
    for (const item of items) {
      out.push(at)
      at += item.kind === 'header' ? HEADER : CELL
    }
    return out
  }, [items])

  const pick = (code: string) => {
    rememberEmoji(code)
    onPick(code)
  }

  return (
    <View
      className={cn('w-[312px] overflow-hidden rounded-lg border border-border bg-card shadow-md', className)}
      testID="emoji-picker"
    >
      <View className="border-b border-border p-2">
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search emoji"
          placeholderTextColor="#8a8a8a"
          autoFocus={Platform.OS === 'web'}
          accessibilityLabel="Search emoji"
          className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground"
        />
      </View>
      {!query.trim() && (
        <View className="flex-row border-b border-border px-1">
          {sectionStarts.map((s) => (
            <Pressable
              key={s.title}
              accessibilityLabel={s.title}
              onPress={() => listRef.current?.scrollToIndex({ index: s.index, animated: false })}
              className="flex-1 items-center rounded py-1 active:bg-muted hover:bg-muted"
            >
              <Text className="text-sm">{s.icon}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <FlatList
        ref={listRef}
        data={items}
        keyExtractor={(item) => item.key}
        style={{ height: 280 }}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={12}
        windowSize={5}
        getItemLayout={(data, index) => ({
          length: data![index]!.kind === 'header' ? HEADER : CELL,
          offset: offsets[index] ?? 0,
          index,
        })}
        ListEmptyComponent={<Text className="p-4 text-center text-xs text-muted-foreground">No emoji match “{query}”.</Text>}
        renderItem={({ item }) =>
          item.kind === 'header' ? (
            <Text style={{ height: HEADER }} className="px-2.5 pt-1.5 text-[11px] font-semibold uppercase text-muted-foreground">
              {item.title}
            </Text>
          ) : (
            <View className="flex-row px-1" style={{ height: CELL }}>
              {item.cells.map((c) => (
                <Pressable
                  key={c.code}
                  accessibilityLabel={c.label}
                  {...({ title: c.label } as object)}
                  onPress={() => pick(c.code)}
                  style={{ width: CELL, height: CELL }}
                  className="items-center justify-center rounded active:bg-muted hover:bg-muted"
                >
                  {c.imageUrl ? (
                    <Image source={{ uri: c.imageUrl }} style={{ width: 22, height: 22 }} />
                  ) : (
                    <Text style={{ fontSize: 20 }}>{c.code}</Text>
                  )}
                </Pressable>
              ))}
            </View>
          )
        }
      />
    </View>
  )
}
