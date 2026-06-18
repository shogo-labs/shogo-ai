import { useEffect, useState } from 'react'
import { ExternalLink, FolderOpen, Loader2 } from 'lucide-react-native'

interface ShogoIdeStatus {
  phase: 2
  workspacePath: string
  codeOssCheckoutExists: boolean
  executableExists: boolean
  launchReady: boolean
  reason: string
  cloneCommand: string
}

interface ShogoIdeBridge {
  getStatus(): Promise<ShogoIdeStatus>
  launch(opts?: { workspacePath?: string }): Promise<{ ok: boolean; status: ShogoIdeStatus; error?: string }>
  openWorkspaceFolder(): Promise<{ ok: boolean; status: ShogoIdeStatus; error?: string }>
}

function getBridge(): ShogoIdeBridge | null {
  if (typeof window === 'undefined') return null
  const bridge = (window as unknown as { shogoDesktop?: { shogoIde?: Partial<ShogoIdeBridge> } }).shogoDesktop?.shogoIde
  if (!bridge) return null
  if (
    typeof bridge.getStatus !== 'function' ||
    typeof bridge.launch !== 'function' ||
    typeof bridge.openWorkspaceFolder !== 'function'
  ) {
    return null
  }
  return bridge as ShogoIdeBridge
}

export function ShogoIdePhase2Launcher({ projectRoot }: { projectRoot?: string | null }) {
  const [bridge] = useState(() => getBridge())
  const [status, setStatus] = useState<ShogoIdeStatus | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!bridge) return
    let cancelled = false
    bridge.getStatus()
      .then((nextStatus) => {
        if (!cancelled) setStatus(nextStatus)
      })
      .catch((error) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : String(error))
      })
    return () => { cancelled = true }
  }, [bridge])

  if (!bridge || !status) return null

  const launch = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await bridge.launch(projectRoot ? { workspacePath: projectRoot } : undefined)
      setStatus(result.status)
      setMessage(result.ok ? 'External IDE dev runtime launch requested.' : result.error || result.status.reason)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const reveal = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await bridge.openWorkspaceFolder()
      setStatus(result.status)
      if (!result.ok) setMessage(result.error || 'Could not reveal Shogo IDE workspace.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pointer-events-auto absolute right-3 top-3 z-50 w-[360px] max-w-[calc(100%-24px)] rounded-xl border border-[color:var(--ide-border)] bg-[color:var(--ide-panel)]/95 p-3 text-[color:var(--ide-text)] shadow-2xl backdrop-blur">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-semibold text-[color:var(--ide-text-strong)]">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-orange-500 text-white">⌘</span>
            External IDE Dev Runtime
            <span className="rounded-full border border-[color:var(--ide-border)] px-1.5 py-0.5 text-[10px] text-[color:var(--ide-muted)]">
              Phase 2
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-4 text-[color:var(--ide-muted)]">
            {status.launchReady ? 'Code OSS dev launcher is wired behind the explicit developer flag. The in-app IDE remains the product surface.' : status.reason}
          </p>
          {message && (
            <p className="mt-1 rounded-md bg-[color:var(--ide-bg)] px-2 py-1 text-[10px] leading-4 text-[color:var(--ide-muted)]">
              {message}
            </p>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={launch}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-orange-500 px-2.5 text-xs font-semibold text-white transition-colors hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? <Loader2 size={13} /> : <ExternalLink size={13} />}
          Open external IDE (dev)
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={reveal}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[color:var(--ide-border)] px-2.5 text-xs font-medium text-[color:var(--ide-text-strong)] transition-colors hover:bg-[color:var(--ide-bg)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          <FolderOpen size={13} />
          Reveal files
        </button>
      </div>
      {!status.launchReady && (
        <div className="mt-2 select-text rounded-md border border-[color:var(--ide-border)] bg-[color:var(--ide-bg)] px-2 py-1.5 font-mono text-[10px] leading-4 text-[color:var(--ide-muted)]">
          {status.cloneCommand}
        </div>
      )}
    </div>
  )
}
