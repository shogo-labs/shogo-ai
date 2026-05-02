// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { useState, useEffect, useRef, useMemo } from 'react'
import { View, Text, Pressable, ScrollView } from 'react-native'
import { Terminal, Trash2, ChevronDown, ChevronRight, CheckCircle2, XCircle } from 'lucide-react-native'
import { cn } from '@shogo/shared-ui/primitives'
import { extractExecEntries, type ExecEntry } from './extractExecEntries'

export { extractExecEntries }
export type { ExecEntry }

export interface TerminalPanelProps {
  /** Chat messages from useChat — exec entries are derived from tool-invocation parts */
  messages: any[]
  visible: boolean
}

const MAX_PREVIEW_LINES = 4
const MAX_OUTPUT_CHARS = 8000

function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function truncateOutput(text: string): { display: string; isTruncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { display: text, isTruncated: false }
  const half = Math.floor(MAX_OUTPUT_CHARS / 2)
  return {
    display: text.slice(0, half) + '\n\n  ── truncated ──\n\n' + text.slice(-half),
    isTruncated: true,
  }
}

function ExecEntryRow({ entry }: { entry: ExecEntry }) {
  const [expanded, setExpanded] = useState(false)
  const hasOutput = entry.stdout || entry.stderr
  const output = [entry.stdout, entry.stderr].filter(Boolean).join('\n')
  const { display: truncated } = truncateOutput(output)
  const isError = entry.exitCode !== 0 && entry.exitCode !== -1

  const previewLines = useMemo(() => {
    if (!hasOutput) return ''
    const lines = output.split('\n')
    if (lines.length <= MAX_PREVIEW_LINES) return output
    return lines.slice(0, MAX_PREVIEW_LINES).join('\n') + `\n  … ${lines.length - MAX_PREVIEW_LINES} more lines`
  }, [output, hasOutput])

  return (
    <View className={cn('border-b border-gray-800/50', isError && 'bg-red-950/20')}>
      <Pressable
        onPress={() => setExpanded(!expanded)}
        className="flex-row items-start gap-2 px-4 py-2.5"
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3 text-gray-500 mt-0.5" size={12} />
        ) : (
          <ChevronRight className="w-3 h-3 text-gray-500 mt-0.5" size={12} />
        )}

        <View className="flex-1 gap-0.5">
          <Text className="font-mono text-xs text-gray-200" selectable>
            <Text className="text-emerald-400">$</Text> {entry.command}
          </Text>

          {!expanded && hasOutput && (
            <Text className="font-mono text-[10px] text-gray-500 mt-0.5" numberOfLines={MAX_PREVIEW_LINES}>
              {previewLines}
            </Text>
          )}
        </View>

        <View className="flex-row items-center gap-2 shrink-0">
          {entry.durationMs != null && (
            <Text className="font-mono text-[9px] text-gray-600">
              {formatDuration(entry.durationMs)}
            </Text>
          )}
          <Text className="font-mono text-[9px] text-gray-600">
            {formatTimestamp(entry.timestamp)}
          </Text>
          {entry.exitCode === -1 ? null : isError ? (
            <XCircle className="w-3 h-3 text-red-500" size={12} />
          ) : (
            <CheckCircle2 className="w-3 h-3 text-emerald-600" size={12} />
          )}
        </View>
      </Pressable>

      {expanded && hasOutput && (
        <View className="px-4 pb-3">
          <ScrollView
            nestedScrollEnabled
            className="bg-black/40 rounded p-3 max-h-64"
          >
            <Text
              className={cn(
                'font-mono text-[11px]',
                entry.stderr && !entry.stdout ? 'text-red-400' : 'text-gray-300'
              )}
              selectable
            >
              {truncated}
            </Text>
          </ScrollView>
          {isError && (
            <Text className="font-mono text-[9px] text-red-400 mt-1">
              exit code {entry.exitCode}
            </Text>
          )}
        </View>
      )}

      {expanded && !hasOutput && (
        <View className="px-4 pb-3">
          <Text className="font-mono text-[10px] text-gray-600 italic">
            {entry.exitCode === -1 ? 'Running…' : 'No output'}
          </Text>
        </View>
      )}
    </View>
  )
}

export function TerminalPanel({ messages, visible }: TerminalPanelProps) {
  const [cleared, setCleared] = useState(false)
  const [clearTimestamp, setClearTimestamp] = useState(0)
  const scrollRef = useRef<ScrollView>(null)

  const allEntries = useMemo(() => extractExecEntries(messages), [messages])

  const entries = useMemo(() => {
    if (!cleared) return allEntries
    return allEntries.filter(e => e.timestamp > clearTimestamp)
  }, [allEntries, cleared, clearTimestamp])

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: false })
  }, [entries.length])

  if (!visible) return null

  return (
    <View className="absolute inset-0 flex-col" style={{ display: visible ? 'flex' : 'none' }}>
      <View className="px-4 py-3 border-b border-border flex-row items-center gap-2">
        <Terminal size={16} className="text-emerald-500" />
        <Text className="text-sm font-medium text-foreground">Terminal</Text>
        <Text className="text-xs text-muted-foreground">{entries.length} commands</Text>

        <View className="ml-auto flex-row items-center gap-3">
          <Pressable
            onPress={() => { setCleared(true); setClearTimestamp(Date.now()) }}
            className="p-1 rounded-md active:bg-muted"
          >
            <Trash2 size={14} className="text-muted-foreground" />
          </Pressable>
        </View>
      </View>

      <ScrollView
        ref={scrollRef}
        className="flex-1 bg-zinc-950"
      >
        {entries.length === 0 ? (
          <View className="items-center py-12 px-6 gap-3">
            <Terminal size={32} className="text-zinc-700" />
            <Text className="text-zinc-500 text-center text-xs">
              No commands executed yet. Commands run by the agent will appear here.
            </Text>
          </View>
        ) : (
          entries.map(entry => (
            <ExecEntryRow key={entry.id} entry={entry} />
          ))
        )}
      </ScrollView>
    </View>
  )
}
