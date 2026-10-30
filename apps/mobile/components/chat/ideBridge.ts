import { useCallback, useEffect, useRef, useState } from "react"
import { Platform } from "react-native"
import { requestChatInsert } from "../../lib/chat-insert-bus"
import type { ChatReferenceInput } from "../../lib/chat-references"

export interface IdeSelectionContext {
  text: string
  startLine: number
  endLine: number
  truncated?: boolean
}

export interface IdeActiveFileContext {
  path: string
  languageId?: string
  selection?: IdeSelectionContext
}

export interface IdeWorkspaceFolderContext {
  name: string
  path: string
}

export interface IdeFileResult {
  type: "file" | "folder"
  path: string
  name: string
}

export interface IdeContextState {
  activeFile?: IdeActiveFileContext
  workspaceFolders: IdeWorkspaceFolderContext[]
  workspaceItems?: IdeFileResult[]
}

export interface IdeReadFileResult {
  type: "file"
  path: string
  contents?: string
  truncated?: boolean
  error?: string
}

const EMPTY_CONTEXT: IdeContextState = { workspaceFolders: [] }

/** Batch ids remembered so a batch Shogo Code re-sends after a reconnect is inserted once. */
const MAX_REMEMBERED_BATCHES = 100

const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0

/** Keep only well-formed file / folder / selection references from Shogo Code. */
export function parseIdeReferences(raw: unknown): ChatReferenceInput[] {
  if (!Array.isArray(raw)) return []
  const out: ChatReferenceInput[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const r = item as Record<string, unknown>
    if (typeof r.path !== "string" || !r.path || typeof r.name !== "string" || !r.name) continue
    if (r.type === "file" || r.type === "folder") {
      out.push({ type: r.type, path: r.path, name: r.name })
    } else if (
      r.type === "selection" &&
      isPositiveInt(r.startLine) &&
      isPositiveInt(r.endLine) &&
      r.endLine >= r.startLine &&
      typeof r.text === "string" &&
      r.text.trim()
    ) {
      out.push({
        type: "selection",
        path: r.path,
        name: r.name,
        startLine: r.startLine,
        endLine: r.endLine,
        text: r.text,
        ...(typeof r.languageId === "string" ? { languageId: r.languageId } : {}),
        ...(r.truncated === true ? { truncated: true } : {}),
      })
    }
  }
  return out
}

function canUseWindow(): boolean {
  return Platform.OS === "web" && typeof window !== "undefined" && !!window.parent
}

function requestId(): string {
  return `ide-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function useIdeBridge(enabled: boolean) {
  const [context, setContext] = useState<IdeContextState>(EMPTY_CONTEXT)
  const [isConnected, setIsConnected] = useState(false)
  const pending = useRef(
    new Map<
      string,
      {
        resolve: (value: any) => void
        timeout: ReturnType<typeof setTimeout>
      }
    >(),
  )

  const post = useCallback((message: Record<string, unknown>) => {
    if (!enabled || !canUseWindow()) return
    window.parent.postMessage(message, "*")
  }, [enabled])
  // Batch ids, in arrival order, and whether the composer has inserted them yet.
  const batchesRef = useRef(new Map<string, "pending" | "applied">())

  useEffect(() => {
    if (!enabled || !canUseWindow()) return

    const handleMessage = (event: MessageEvent) => {
      // Only the IDE host embedding this chat may drive it; another frame or
      // an opener could otherwise inject "selected" code as context.
      if (event.source !== window.parent) return
      const message = event.data
      if (!message || typeof message.type !== "string") return

      if (message.type === "shogo.ide.hostReady") {
        setIsConnected(true)
        post({ type: "shogo.ide.ready" })
        return
      }

      if (message.type === "shogo.ide.context") {
        setIsConnected(true)
        setContext({
          activeFile: message.activeFile,
          workspaceFolders: Array.isArray(message.workspaceFolders) ? message.workspaceFolders : [],
          workspaceItems: Array.isArray(message.workspaceItems) ? message.workspaceItems : [],
        })
        return
      }

      // "Add to Chat" in Shogo Code (⌘L, editor/Explorer menus, Explorer drops).
      if (message.type === "shogo.ide.addReferences") {
        const batchId = typeof message.batchId === "string" ? message.batchId : ""
        if (!batchId) return
        const batches = batchesRef.current
        const ack = () => post({ type: "shogo.ide.referencesAck", batchId })
        const known = batches.get(batchId)
        // A re-sent batch is acked once it has been inserted; a pending one
        // acks when the composer applies it.
        if (known === "applied") ack()
        if (known) return
        batches.set(batchId, "pending")
        while (batches.size > MAX_REMEMBERED_BATCHES) batches.delete(batches.keys().next().value!)
        const markApplied = () => {
          if (batches.has(batchId)) batches.set(batchId, "applied")
          ack()
        }
        const references = parseIdeReferences(message.references)
        if (references.length > 0) requestChatInsert({ references, source: "shogo-code", onApplied: markApplied })
        else markApplied()
        return
      }

      if (message.type === "shogo.ide.fileResults" || message.type === "shogo.ide.readFilesResult") {
        const id = typeof message.requestId === "string" ? message.requestId : ""
        const entry = pending.current.get(id)
        if (!entry) return
        pending.current.delete(id)
        clearTimeout(entry.timeout)
        entry.resolve(message)
      }
    }

    window.addEventListener("message", handleMessage)
    post({ type: "shogo.ide.ready" })
    return () => {
      window.removeEventListener("message", handleMessage)
      pending.current.forEach((entry) => clearTimeout(entry.timeout))
      pending.current.clear()
    }
  }, [enabled, post])

  const request = useCallback(
    <T,>(message: Record<string, unknown>, fallback: T): Promise<T> => {
      if (!enabled || !canUseWindow()) return Promise.resolve(fallback)
      const id = requestId()
      return new Promise<T>((resolve) => {
        const timeout = setTimeout(() => {
          pending.current.delete(id)
          resolve(fallback)
        }, 2500)
        pending.current.set(id, { resolve: (value) => resolve(value as T), timeout })
        post({ ...message, requestId: id })
      })
    },
    [enabled, post],
  )

  const listFiles = useCallback(
    async (query?: string): Promise<IdeFileResult[]> => {
      const response = await request<{ items?: IdeFileResult[] }>(
        { type: "shogo.ide.listFiles", query },
        { items: [] },
      )
      return Array.isArray(response.items) ? response.items : []
    },
    [request],
  )

  const readFiles = useCallback(
    async (paths: string[]): Promise<IdeReadFileResult[]> => {
      const response = await request<{ files?: IdeReadFileResult[] }>(
        { type: "shogo.ide.readFiles", paths },
        { files: [] },
      )
      return Array.isArray(response.files) ? response.files : []
    },
    [request],
  )

  const openFile = useCallback((path: string) => {
    post({ type: "shogo.ide.openFile", path })
  }, [post])

  return {
    context,
    isConnected,
    listFiles,
    readFiles,
    openFile,
  }
}
