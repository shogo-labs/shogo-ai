// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useStreamingText Hook (React Native)
 *
 * Tracks content deltas for progressive text streaming animation.
 * Returns chunks with unique IDs and isNew flags for animation triggers.
 * Pure React hook — identical to web version, no DOM dependencies.
 */

import { useState, useEffect, useRef, useMemo } from "react"

export interface TextChunk {
  id: string
  text: string
  isNew: boolean
}

export interface StreamingTextState {
  chunks: TextChunk[]
  isStreaming: boolean
}

const ANIMATION_DURATION_MS = 200
const MAX_CHUNK_SIZE = 50
const CHUNK_STAGGER_MS = 30

function splitIntoChunks(text: string): string[] {
  if (!text) return []

  const chunks: string[] = []
  let current = ""

  for (let i = 0; i < text.length; i++) {
    current += text[i]

    const isWordBoundary = /\s/.test(text[i])
    const isSentenceEnd =
      /[.!?]/.test(text[i]) &&
      (text[i + 1] === " " || text[i + 1] === "\n" || i === text.length - 1)

    if (
      (isWordBoundary || isSentenceEnd || current.length >= MAX_CHUNK_SIZE) &&
      current.length > 0
    ) {
      chunks.push(current)
      current = ""
    }
  }

  if (current) {
    chunks.push(current)
  }

  return chunks.length > 0 ? chunks : text ? [text] : []
}

export function useStreamingText(content: string, isStreaming: boolean): StreamingTextState {
  const prevContentLengthRef = useRef<number>(0)
  const [chunks, setChunks] = useState<TextChunk[]>([])
  const chunkIdRef = useRef<number>(0)
  const pendingTimeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  useEffect(() => {
    const prevLength = prevContentLengthRef.current
    const currentLength = content.length

    if (currentLength > prevLength && isStreaming) {
      const newText = content.slice(prevLength)
      const newChunks = splitIntoChunks(newText)

      newChunks.forEach((chunkText, index) => {
        const staggerDelay = index * CHUNK_STAGGER_MS

        const addTimeout = setTimeout(() => {
          const chunkId = `chunk-${++chunkIdRef.current}`

          setChunks((prev) => [
            ...prev,
            {
              id: chunkId,
              text: chunkText,
              isNew: true,
            },
          ])

          const clearT = setTimeout(() => {
            setChunks((prev) =>
              prev.map((chunk) =>
                chunk.id === chunkId ? { ...chunk, isNew: false } : chunk
              )
            )
            pendingTimeoutsRef.current.delete(clearT)
          }, ANIMATION_DURATION_MS)

          pendingTimeoutsRef.current.add(clearT)
          pendingTimeoutsRef.current.delete(addTimeout)
        }, staggerDelay)

        pendingTimeoutsRef.current.add(addTimeout)
      })
    }

    if (currentLength < prevLength || (currentLength === 0 && chunks.length > 0)) {
      setChunks([])
      chunkIdRef.current = 0
    }

    prevContentLengthRef.current = currentLength
  }, [content, isStreaming])

  useEffect(() => {
    if (!isStreaming && chunks.length > 1) {
      const consolidateTimeout = setTimeout(() => {
        const combinedText = chunks.map((c) => c.text).join("")
        if (combinedText) {
          setChunks([
            {
              id: "combined",
              text: combinedText,
              isNew: false,
            },
          ])
        }
      }, ANIMATION_DURATION_MS + 50)

      return () => clearTimeout(consolidateTimeout)
    }
  }, [isStreaming, chunks.length])

  useEffect(() => {
    return () => {
      pendingTimeoutsRef.current.forEach((id) => clearTimeout(id))
      pendingTimeoutsRef.current.clear()
    }
  }, [])

  return useMemo(
    () => ({
      chunks,
      isStreaming,
    }),
    [chunks, isStreaming]
  )
}

export default useStreamingText
