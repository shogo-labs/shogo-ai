// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * FolderPickerModal
 *
 * In-app directory picker for the "Open Folder…" flow when Electron's
 * native `dialog.showOpenDialog` isn't available — i.e. when running
 * `bun dev:all` in a plain browser. Browsers deliberately hide absolute
 * filesystem paths from JavaScript (sandboxing since ~2012), so the
 * standard pattern when you also own the server is to list directories
 * on the server side and let the user navigate that listing visually.
 *
 * Same pattern JupyterLab's `FileDialog.getExistingDirectory` and
 * `jupyter-host-file-picker` use. Reasonable here because the picker is
 * gated on `SHOGO_LOCAL_MODE=true`, where the API process IS the user's
 * machine — there is no "other host" we'd be exposing.
 *
 * Backend: GET /api/local/projects/fs/browse — returns `{ path, parent,
 * home, entries[], truncated? }`. The same validators as POST /from-folders
 * (`under $HOME`, `not forbidden_root`, `realpathSync` symlink-escape
 * defense) gate the listing so the picker can never show a folder the
 * create endpoint would reject.
 *
 * Out-of-scope (deliberately, see the plan):
 *   - No multi-select. Multi-root projects happen later via the
 *     FoldersPanel after binding.
 *   - No "create new folder" button. Create accepts only existing
 *     folders today.
 *   - No path completion / typeahead.
 */
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, Platform, Pressable, View } from 'react-native'
import {
  Modal,
  ModalBackdrop,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  ModalCloseButton,
} from '@/components/ui/modal'
import { Heading } from '@/components/ui/heading'
import { Text } from '@/components/ui/text'
import { Button, ButtonText, ButtonSpinner } from '@/components/ui/button'
import {
  ArrowUp,
  ChevronRight,
  Folder,
  FolderOpen,
  Home as HomeIcon,
  Link as LinkIcon,
  X,
} from 'lucide-react-native'
import { api } from '../../lib/api'
import { useDomainHttp } from '../../contexts/domain'
import { cn } from '@shogo/shared-ui/primitives'

interface BrowseEntry {
  name: string
  isDirectory: boolean
  isSymlink: boolean
  hidden: boolean
}

interface BrowseResponse {
  path: string
  parent: string | null
  home: string
  entries: BrowseEntry[]
  truncated?: boolean
}

export interface FolderPickerModalProps {
  open: boolean
  /** Optional starting path. Falls back to `$HOME` returned by the API. */
  initialPath?: string
  /** Called with the absolute path the user confirmed. */
  onSelect: (absolutePath: string) => void
  /** Called when the user dismisses without picking. */
  onClose: () => void
  /** Title text. Defaults to "Open folder". */
  title?: string
}

/**
 * Split a path into clickable breadcrumb segments. We keep the leading
 * separator on the first segment (`/Users` becomes `/Users` not `Users`)
 * so the breadcrumb reads correctly on POSIX. Windows paths render as
 * `C:` `Users` `…` which is also accurate.
 */
function breadcrumbSegments(absPath: string): Array<{ label: string; path: string }> {
  if (!absPath) return []
  // Normalize separators for display; we use the original for API calls.
  const isWin = absPath.includes('\\')
  const sep = isWin ? '\\' : '/'
  const segments = absPath.split(sep).filter((s, i, arr) => s.length > 0 || i === 0)
  const out: Array<{ label: string; path: string }> = []
  let acc = isWin ? '' : sep
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]
    if (!s) continue
    if (i === 0 && !isWin) {
      acc = sep + s
      out.push({ label: s, path: acc })
    } else if (i === 0 && isWin) {
      acc = s
      out.push({ label: s || sep, path: acc + sep })
    } else {
      acc = acc.endsWith(sep) ? acc + s : acc + sep + s
      out.push({ label: s, path: acc })
    }
  }
  return out
}

export const FolderPickerModal = memo(function FolderPickerModal({
  open,
  initialPath,
  onSelect,
  onClose,
  title = 'Open folder',
}: FolderPickerModalProps) {
  const http = useDomainHttp()
  const [path, setPath] = useState<string | null>(initialPath ?? null)
  const [parent, setParent] = useState<string | null>(null)
  const [home, setHome] = useState<string | null>(null)
  const [entries, setEntries] = useState<BrowseEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [highlight, setHighlight] = useState<number>(-1)
  const [showHidden, setShowHidden] = useState(false)
  // Tracks the last `path` we navigated to so concurrent in-flight
  // responses don't clobber the visible entries when the user clicks
  // through directories quickly (race-condition fix).
  const requestSeq = useRef(0)

  // Reset when the modal closes so the next open starts fresh at the
  // user's home directory rather than the previous session's path.
  useEffect(() => {
    if (!open) {
      setPath(initialPath ?? null)
      setEntries([])
      setError(null)
      setHighlight(-1)
      setTruncated(false)
    }
  }, [open, initialPath])

  const load = useCallback(
    async (target: string | undefined) => {
      const myReq = ++requestSeq.current
      setLoading(true)
      setError(null)
      const res = await api.browseLocalFolder(http, { path: target })
      if (myReq !== requestSeq.current) return
      setLoading(false)
      if ('error' in res) {
        setError(res.error)
        setEntries([])
        return
      }
      setPath(res.path)
      setParent(res.parent)
      setHome(res.home)
      setEntries(res.entries)
      setTruncated(Boolean(res.truncated))
      setHighlight(res.entries.length > 0 ? 0 : -1)
    },
    [http],
  )

  // First load on open. Done in an effect so we honor any externally
  // changed `initialPath` between renders.
  useEffect(() => {
    if (!open) return
    void load(initialPath)
  }, [open, initialPath, load])

  const visibleEntries = useMemo(() => {
    return showHidden ? entries : entries.filter((e) => !e.hidden)
  }, [entries, showHidden])

  // Clamp highlight to visible range whenever the filter changes.
  useEffect(() => {
    if (visibleEntries.length === 0) {
      if (highlight !== -1) setHighlight(-1)
      return
    }
    if (highlight < 0 || highlight >= visibleEntries.length) {
      setHighlight(0)
    }
  }, [visibleEntries, highlight])

  const descend = useCallback(
    (entry: BrowseEntry) => {
      if (!entry.isDirectory || !path) return
      const sep = path.includes('\\') ? '\\' : '/'
      const next = path.endsWith(sep) ? path + entry.name : path + sep + entry.name
      void load(next)
    },
    [path, load],
  )

  const goUp = useCallback(() => {
    if (parent) void load(parent)
  }, [parent, load])

  const goHome = useCallback(() => {
    if (home) void load(home)
  }, [home, load])

  const handleSelect = useCallback(() => {
    if (path) onSelect(path)
  }, [path, onSelect])

  // Keyboard nav — web only. RN swallows key events on most native
  // platforms, but on web the Pressables receive synthetic events.
  // We attach a single window-level listener while the modal is open
  // so arrow keys work regardless of focus inside the list.
  useEffect(() => {
    if (!open) return
    if (Platform.OS !== 'web' || typeof window === 'undefined') return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlight((h) => Math.min(visibleEntries.length - 1, Math.max(0, h + 1)))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlight((h) => Math.max(0, h - 1))
      } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        const entry = visibleEntries[highlight]
        if (entry?.isDirectory) {
          e.preventDefault()
          descend(entry)
        } else if (e.key === 'Enter') {
          // Enter on an empty / non-dir highlight = select the current dir.
          e.preventDefault()
          handleSelect()
        }
      } else if (e.key === 'ArrowLeft' || e.key === 'Backspace') {
        if (parent) {
          e.preventDefault()
          goUp()
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, visibleEntries, highlight, parent, descend, goUp, handleSelect, onClose])

  const basename = useMemo(() => {
    if (!path) return ''
    const sep = path.includes('\\') ? '\\' : '/'
    const parts = path.split(sep).filter(Boolean)
    return parts[parts.length - 1] ?? path
  }, [path])

  const crumbs = useMemo(() => (path ? breadcrumbSegments(path) : []), [path])

  return (
    <Modal isOpen={open} onClose={onClose} size="lg">
      <ModalBackdrop />
      <ModalContent className="bg-background-0 p-0">
        <ModalHeader className="px-6 pt-5 pb-3 border-b border-outline-100">
          <View className="flex-row items-start gap-3 flex-1">
            <View className="mt-0.5">
              <FolderOpen size={20} className="text-typography-700" />
            </View>
            <View className="flex-1">
              <Heading size="sm" className="text-typography-900">
                {title}
              </Heading>
              <Text className="text-xs text-typography-500 mt-0.5">
                Navigate to the folder you want to open, then click Select.
              </Text>
            </View>
          </View>
          <ModalCloseButton>
            <X size={18} className="text-typography-500" />
          </ModalCloseButton>
        </ModalHeader>

        {/* Toolbar: Home, Up, breadcrumb, Show hidden */}
        <View className="px-6 py-2 border-b border-outline-100 flex-row items-center gap-2">
          <Pressable
            onPress={goHome}
            disabled={!home}
            className={cn(
              'flex-row items-center gap-1 px-2 py-1 rounded-md border border-outline-100',
              !home ? 'opacity-50' : 'active:bg-background-50',
            )}
            accessibilityLabel="Home folder"
          >
            <HomeIcon size={13} className="text-typography-600" />
            <Text className="text-xs text-typography-700">Home</Text>
          </Pressable>
          <Pressable
            onPress={goUp}
            disabled={!parent}
            className={cn(
              'flex-row items-center gap-1 px-2 py-1 rounded-md border border-outline-100',
              !parent ? 'opacity-50' : 'active:bg-background-50',
            )}
            accessibilityLabel="Parent folder"
          >
            <ArrowUp size={13} className="text-typography-600" />
            <Text className="text-xs text-typography-700">Up</Text>
          </Pressable>
          <View className="flex-1 flex-row items-center flex-wrap">
            {crumbs.length === 0 ? (
              <Text className="text-xs text-typography-500">…</Text>
            ) : (
              crumbs.map((c, i) => (
                <View key={c.path} className="flex-row items-center">
                  <Pressable
                    onPress={() => void load(c.path)}
                    className="px-1 py-0.5 rounded active:bg-background-50"
                  >
                    <Text
                      className={cn(
                        'text-xs font-mono',
                        i === crumbs.length - 1
                          ? 'text-typography-900 font-medium'
                          : 'text-typography-500',
                      )}
                    >
                      {c.label}
                    </Text>
                  </Pressable>
                  {i < crumbs.length - 1 ? (
                    <ChevronRight size={11} className="text-typography-400" />
                  ) : null}
                </View>
              ))
            )}
          </View>
          <Pressable
            onPress={() => setShowHidden((v) => !v)}
            className={cn(
              'px-2 py-1 rounded-md border',
              showHidden
                ? 'border-primary-300 bg-primary-50'
                : 'border-outline-100 active:bg-background-50',
            )}
            accessibilityLabel="Toggle hidden folders"
          >
            <Text
              className={cn(
                'text-xs',
                showHidden ? 'text-primary-700 font-medium' : 'text-typography-600',
              )}
            >
              {showHidden ? '✓ Hidden' : 'Hidden'}
            </Text>
          </Pressable>
        </View>

        <ModalBody className="px-0 py-0" contentContainerClassName="gap-0">
          <View className="min-h-[320px] max-h-[420px]">
            {error ? (
              <View className="px-6 py-8 items-center">
                <Text className="text-sm text-error-600 text-center">{error}</Text>
                <Pressable
                  onPress={() => void load(path ?? initialPath)}
                  className="mt-3 px-3 py-1.5 rounded-md border border-outline-200"
                >
                  <Text className="text-xs text-typography-700">Retry</Text>
                </Pressable>
              </View>
            ) : loading && entries.length === 0 ? (
              <View className="px-6 py-8 items-center">
                <Text className="text-xs text-typography-500">Loading…</Text>
              </View>
            ) : visibleEntries.length === 0 ? (
              <View className="px-6 py-8 items-center">
                <Text className="text-xs text-typography-500">
                  {entries.length === 0
                    ? 'This folder is empty.'
                    : 'No visible folders. Toggle "Hidden" to show dot-folders.'}
                </Text>
              </View>
            ) : (
              <FlatList
                data={visibleEntries}
                keyExtractor={(item) => item.name}
                renderItem={({ item, index }) => (
                  <EntryRow
                    entry={item}
                    selected={index === highlight}
                    onPress={() => {
                      setHighlight(index)
                    }}
                    onActivate={() => descend(item)}
                  />
                )}
                initialNumToRender={30}
                windowSize={5}
              />
            )}
            {truncated ? (
              <Text className="px-6 py-2 text-[10px] text-typography-500 border-t border-outline-100">
                Showing first 1000 entries — refine the path to see more.
              </Text>
            ) : null}
          </View>
        </ModalBody>

        <ModalFooter className="px-6 py-3 border-t border-outline-100 flex-row items-center justify-between gap-2">
          <View className="flex-1 flex-row items-center gap-2">
            {path ? (
              <>
                <Folder size={13} className="text-typography-500" />
                <Text
                  className="text-xs font-mono text-typography-700 flex-1"
                  numberOfLines={1}
                  ellipsizeMode="middle"
                >
                  {path}
                </Text>
              </>
            ) : null}
          </View>
          <Button variant="outline" onPress={onClose}>
            <ButtonText>Cancel</ButtonText>
          </Button>
          <Button
            className="bg-primary-600"
            isDisabled={!path || loading}
            onPress={handleSelect}
          >
            {loading ? (
              <ButtonSpinner />
            ) : (
              <ButtonText className="text-white">
                {basename ? `Select "${basename}"` : 'Select'}
              </ButtonText>
            )}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  )
})

/**
 * Individual directory row. Single tap highlights + focuses; double tap
 * (or Enter while highlighted) descends. On native we treat the second
 * tap within 300 ms as "activate", which is the convention native file
 * managers use too.
 */
const EntryRow = memo(function EntryRow({
  entry,
  selected,
  onPress,
  onActivate,
}: {
  entry: BrowseEntry
  selected: boolean
  onPress: () => void
  onActivate: () => void
}) {
  const lastPress = useRef(0)
  const handlePress = () => {
    const now = Date.now()
    onPress()
    if (entry.isDirectory && now - lastPress.current < 300) {
      onActivate()
    }
    lastPress.current = now
  }
  return (
    <Pressable
      onPress={handlePress}
      className={cn(
        'flex-row items-center gap-2 px-6 py-2 border-b border-outline-50',
        selected ? 'bg-primary-50' : 'active:bg-background-50',
        !entry.isDirectory ? 'opacity-50' : null,
      )}
    >
      {entry.isSymlink ? (
        <LinkIcon size={14} className="text-typography-500" />
      ) : (
        <Folder size={14} className="text-typography-500" />
      )}
      <Text
        className={cn(
          'text-sm flex-1',
          entry.hidden ? 'text-typography-500 italic' : 'text-typography-800',
        )}
        numberOfLines={1}
      >
        {entry.name}
      </Text>
      {entry.isDirectory ? (
        <ChevronRight size={14} className="text-typography-400" />
      ) : null}
    </Pressable>
  )
})
