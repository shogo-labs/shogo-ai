// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react"
import { Pressable, Text, TextInput, View } from "react-native"
import { ArrowUp, Paperclip, Square, X } from "lucide-react-native"
import { cn } from "@shogo/shared-ui/primitives"
import { MAX_FILES } from "../../lib/composer-attachments"
import type { IslandBridge, IslandFileRef, IslandResult } from "./types"

const MIN_INPUT_HEIGHT = 20
const MAX_INPUT_HEIGHT = 120

export interface IslandComposerHandle {
  focus(): void
  addFiles(files: IslandFileRef[]): void
}

export function fileRefsFromFileList(bridge: IslandBridge, files: FileList | File[] | null): IslandFileRef[] {
  const out: IslandFileRef[] = []
  for (const file of Array.from(files ?? [])) {
    const path = bridge.getPathForFile(file)
    if (path) out.push({ path, name: file.name, type: file.type })
  }
  return out
}

export const IslandComposer = forwardRef<
  IslandComposerHandle,
  {
    bridge: IslandBridge
    initialFiles?: IslandFileRef[]
    placeholder: string
    isStreaming: boolean
    onSend: (text: string, files: IslandFileRef[]) => Promise<IslandResult>
    onStop?: () => void
    onFocus: () => void
    onDraftChange?: (hasDraft: boolean) => void
    targetChip?: React.ReactNode
  }
>(function IslandComposer(
  { bridge, initialFiles, placeholder, isStreaming, onSend, onStop, onFocus, onDraftChange, targetChip },
  ref,
) {
  const inputRef = useRef<TextInput>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [text, setText] = useState("")
  const [files, setFiles] = useState<IslandFileRef[]>(() => (initialFiles ?? []).slice(0, MAX_FILES))
  const [height, setHeight] = useState(MIN_INPUT_HEIGHT)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const draftRef = useRef({ text, files })
  draftRef.current = { text, files }

  const updateDraft = (nextText: string, nextFiles: IslandFileRef[]) => {
    onDraftChange?.(!!nextText.trim() || nextFiles.length > 0)
  }

  useEffect(() => {
    onDraftChange?.(files.length > 0)
    return () => onDraftChange?.(false)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const addFiles = (incoming: IslandFileRef[]) => {
    setError(null)
    setFiles((current) => {
      const seen = new Set(current.map((file) => file.path))
      const merged = [...current, ...incoming.filter((file) => !seen.has(file.path))]
      if (merged.length > MAX_FILES) setError(`You can attach up to ${MAX_FILES} files`)
      const next = merged.slice(0, MAX_FILES)
      updateDraft(text, next)
      return next
    })
  }

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    addFiles,
  }))

  const canSend = (!!text.trim() || files.length > 0) && !sending

  const submit = async () => {
    if (!canSend) return
    const sentText = text
    const sentFiles = files
    setSending(true)
    setError(null)
    // Clear right away: an island-owned chat's send only resolves once the
    // whole reply has streamed, so waiting would leave the message in the box.
    setText("")
    setFiles([])
    setHeight(MIN_INPUT_HEIGHT)
    updateDraft("", [])
    const result = await onSend(sentText, sentFiles)
    setSending(false)
    if (!result.ok) {
      setError(result.error)
      // Put the draft back, unless the user has already started a new one.
      if (!draftRef.current.text && draftRef.current.files.length === 0) {
        setText(sentText)
        setFiles(sentFiles)
        updateDraft(sentText, sentFiles)
      }
    }
  }

  return (
    <View className="gap-1.5 border-t border-white/10 px-3 pb-3 pt-2">
      {files.length > 0 ? (
        <View className="flex-row flex-wrap gap-1">
          {files.map((file) => (
            <View key={file.path} className="flex-row items-center gap-1 rounded-md bg-primary/20 px-1.5 py-0.5">
              <Text className="max-w-[160px] text-[10px] text-zinc-100" numberOfLines={1}>
                {file.name}
              </Text>
              <Pressable
                onPress={() =>
                  setFiles((current) => {
                    const next = current.filter((f) => f.path !== file.path)
                    updateDraft(text, next)
                    return next
                  })
                }
                accessibilityLabel={`Remove ${file.name}`}
              >
                <X size={10} color="#d4d4d8" />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      <View className="flex-row items-end gap-2 rounded-xl border border-white/10 bg-black/30 px-2.5 py-2 focus-within:border-primary">
        <TextInput
          ref={inputRef}
          value={text}
          multiline
          onChangeText={(value) => {
            setText(value)
            updateDraft(value, files)
          }}
          onFocus={onFocus}
          onContentSizeChange={(event) =>
            setHeight(Math.min(MAX_INPUT_HEIGHT, Math.max(MIN_INPUT_HEIGHT, event.nativeEvent.contentSize.height)))
          }
          onKeyPress={(event) => {
            const native = event.nativeEvent as unknown as KeyboardEvent
            if (native.key === "Enter" && !native.shiftKey && !native.isComposing) {
              ;(event as unknown as { preventDefault?: () => void }).preventDefault?.()
              void submit()
            }
          }}
          placeholder={placeholder}
          placeholderTextColor="#71717a"
          onPressIn={onFocus}
          className="flex-1 text-[12px] leading-[18px] text-zinc-100"
          style={[{ height, outlineStyle: "none" } as object]}
        />
        {isStreaming && onStop && !canSend ? (
          <Pressable
            onPress={onStop}
            accessibilityLabel="Stop"
            className="h-7 w-7 items-center justify-center rounded-full bg-white/15"
          >
            <Square size={11} color="#fafafa" fill="#fafafa" />
          </Pressable>
        ) : (
          <Pressable
            onPress={() => void submit()}
            disabled={!canSend}
            accessibilityLabel={isStreaming ? "Queue message" : "Send"}
            className={cn("h-7 w-7 items-center justify-center rounded-full", canSend ? "bg-primary" : "bg-white/10")}
          >
            <ArrowUp size={14} color={canSend ? "#fff" : "#71717a"} />
          </Pressable>
        )}
      </View>
      <View className="flex-row items-center gap-2">
        {targetChip}
        <View className="flex-1" />
        <Pressable
          onPress={() => fileInputRef.current?.click()}
          accessibilityLabel="Attach files"
          className="flex-row items-center gap-1"
        >
          <Paperclip size={12} color="#a1a1aa" />
          <Text className="text-[10px] text-zinc-400">Attach</Text>
        </Pressable>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(event) => {
            addFiles(fileRefsFromFileList(bridge, event.currentTarget.files))
            event.currentTarget.value = ""
          }}
        />
      </View>
      {error ? <Text className="text-[11px] text-rose-400">{error}</Text> : null}
    </View>
  )
})
