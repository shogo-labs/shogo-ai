import { useCallback, useEffect, useRef, useState } from "react"
import { Platform } from "react-native"

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

export interface IdeContextState {
  activeFile?: IdeActiveFileContext
  workspaceFolders: IdeWorkspaceFolderContext[]
}

export interface IdeFileResult {
  type: "file" | "folder"
  path: string
  name: string
}

export interface IdeReadFileResult {
  type: "file"
  path: string
  contents?: string
  truncated?: boolean
  error?: string
}

const EMPTY_CONTEXT: IdeContextState = { workspaceFolders: [] }

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

  useEffect(() => {
    if (!enabled || !canUseWindow()) return

    const handleMessage = (event: MessageEvent) => {
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
        })
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
