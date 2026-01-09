/**
 * useStreamingText Hook
 * Task: task-chat-003
 *
 * Tracks content deltas for progressive text streaming animation.
 * Returns chunks with unique IDs and isNew flags for animation triggers.
 */

import { useState, useEffect, useRef, useMemo } from "react"

/** Individual text chunk for streaming display */
export interface TextChunk {
  /** Unique identifier for React key */
  id: string
  /** The text content of this chunk */
  text: string
  /** Whether this chunk is new (for animation trigger) */
  isNew: boolean
}

/** State returned by useStreamingText hook */
export interface StreamingTextState {
  /** Array of text chunks for rendering */
  chunks: TextChunk[]
  /** Whether streaming is currently active */
  isStreaming: boolean
}

/** Animation duration for fade-in effect (matches CSS) */
const ANIMATION_DURATION_MS = 200

/** Maximum characters per chunk before forcing a split */
const MAX_CHUNK_SIZE = 50

/** Stagger delay between chunk animations (ms) */
const CHUNK_STAGGER_MS = 30

/**
 * Split new text into animation-friendly chunks at word boundaries.
 * Creates smaller chunks that animate more visibly than large blocks.
 */
function splitIntoChunks(text: string): string[] {
  if (!text) return []

  const chunks: string[] = []
  let current = ""

  for (let i = 0; i < text.length; i++) {
    current += text[i]

    // Check for natural boundaries: space, newline, punctuation
    const isWordBoundary = /\s/.test(text[i])
    const isSentenceEnd = /[.!?]/.test(text[i]) && (text[i + 1] === ' ' || text[i + 1] === '\n' || i === text.length - 1)

    if ((isWordBoundary || isSentenceEnd || current.length >= MAX_CHUNK_SIZE) && current.length > 0) {
      chunks.push(current)
      current = ""
    }
  }

  if (current) {
    chunks.push(current)
  }

  return chunks.length > 0 ? chunks : (text ? [text] : [])
}

/**
 * Hook for progressive text streaming animation.
 *
 * Tracks content changes and generates chunks with animation triggers.
 * Each new chunk has isNew=true which is cleared after animation duration.
 *
 * @param content - The current text content (grows during streaming)
 * @param isStreaming - Whether content is actively streaming
 * @returns StreamingTextState with chunks array and streaming status
 *
 * @example
 * ```tsx
 * function StreamingMessage({ content, isStreaming }) {
 *   const { chunks } = useStreamingText(content, isStreaming)
 *
 *   return (
 *     <div>
 *       {chunks.map(chunk => (
 *         <span key={chunk.id} className={chunk.isNew ? "animate-fade-in-chunk" : ""}>
 *           {chunk.text}
 *         </span>
 *       ))}
 *     </div>
 *   )
 * }
 * ```
 */
export function useStreamingText(content: string, isStreaming: boolean): StreamingTextState {
  // Track previous content length for delta detection
  const prevContentLengthRef = useRef<number>(0)

  // Track chunks with their animation state
  const [chunks, setChunks] = useState<TextChunk[]>([])

  // Counter for unique chunk IDs
  const chunkIdRef = useRef<number>(0)

  // Refs to track pending timeouts for cleanup
  const pendingTimeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())

  // Process content changes
  useEffect(() => {
    const prevLength = prevContentLengthRef.current
    const currentLength = content.length

    // If content grew, we have new text to chunk
    if (currentLength > prevLength && isStreaming) {
      const newText = content.slice(prevLength)

      // Split into word-boundary chunks for smoother animation
      const newChunks = splitIntoChunks(newText)

      // Add chunks with staggered timing for progressive reveal
      newChunks.forEach((chunkText, index) => {
        const staggerDelay = index * CHUNK_STAGGER_MS

        const addTimeout = setTimeout(() => {
          const chunkId = `chunk-${++chunkIdRef.current}`

          // Add new chunk with isNew flag
          setChunks(prev => [
            ...prev,
            {
              id: chunkId,
              text: chunkText,
              isNew: true,
            }
          ])

          // Clear isNew flag after animation duration
          const clearTimeout = setTimeout(() => {
            setChunks(prev =>
              prev.map(chunk =>
                chunk.id === chunkId
                  ? { ...chunk, isNew: false }
                  : chunk
              )
            )
            pendingTimeoutsRef.current.delete(clearTimeout)
          }, ANIMATION_DURATION_MS)

          pendingTimeoutsRef.current.add(clearTimeout)
          pendingTimeoutsRef.current.delete(addTimeout)
        }, staggerDelay)

        pendingTimeoutsRef.current.add(addTimeout)
      })
    }

    // If content was cleared or shortened (reset), clear chunks
    if (currentLength < prevLength || (currentLength === 0 && chunks.length > 0)) {
      setChunks([])
      chunkIdRef.current = 0
    }

    prevContentLengthRef.current = currentLength
  }, [content, isStreaming])

  // When streaming stops, consolidate all chunks into one (with delay for animations)
  useEffect(() => {
    if (!isStreaming && chunks.length > 1) {
      // Wait for any pending animations to complete before consolidating
      const consolidateTimeout = setTimeout(() => {
        // Combine all chunks into a single chunk for final state
        const combinedText = chunks.map(c => c.text).join("")
        if (combinedText) {
          setChunks([{
            id: "combined",
            text: combinedText,
            isNew: false,
          }])
        }
      }, ANIMATION_DURATION_MS + 50) // Extra 50ms buffer for animations to complete

      return () => clearTimeout(consolidateTimeout)
    }
  }, [isStreaming, chunks.length])

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      pendingTimeoutsRef.current.forEach(id => clearTimeout(id))
      pendingTimeoutsRef.current.clear()
    }
  }, [])

  return useMemo(() => ({
    chunks,
    isStreaming,
  }), [chunks, isStreaming])
}

export default useStreamingText
