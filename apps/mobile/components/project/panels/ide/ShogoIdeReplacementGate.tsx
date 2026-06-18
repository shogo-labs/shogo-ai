import { useEffect, useState } from 'react'
import { ExternalLink, Loader2 } from 'lucide-react-native'

interface ShogoIdeStatus {
  phase: number
  workspacePath: string
  codeOssCheckoutExists: boolean
  executableExists: boolean
  executableExecutable?: boolean
  generatedProductExists?: boolean
  hardeningReportExists?: boolean
  launchPath?: string | null
  launchMode?: 'packaged' | 'source-runner' | null
  launchReady: boolean
  reason: string
  diagnostics?: string[]
  setupInProgress?: boolean
  setupLogPath?: string
  autoSetupAvailable?: boolean
  cloneCommand: string
}

interface ShogoIdeBridge {
  getStatus(): Promise<ShogoIdeStatus>
  launch(opts?: { workspacePath?: string }): Promise<{ ok: boolean; status: ShogoIdeStatus; error?: string }>
  openWorkspaceFolder(): Promise<{ ok: boolean; status: ShogoIdeStatus; error?: string }>
}

export function getShogoIdeBridge(): ShogoIdeBridge | null {
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

export function ShogoIdeReplacementGate({
  projectName,
  projectRoot,
  workspaceResolved,
}: {
  projectName?: string | null
  projectRoot?: string | null
  workspaceResolved?: boolean
}) {
  const [bridge] = useState(() => getShogoIdeBridge())
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

  const launch = async () => {
    if (!bridge || busy || workspaceResolved === false) return
    setBusy(true)
    setMessage(projectRoot ? 'Opening external IDE dev runtime…' : 'Opening external IDE dev runtime with the default workspace…')
    try {
      const result = await bridge.launch(projectRoot ? { workspacePath: projectRoot } : undefined)
      setStatus(result.status)
      if (result.ok) {
        setMessage(null)
      } else {
        setMessage(result.error || result.status.reason)
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  if (!bridge) return null

  const resolving = workspaceResolved === false
  const disabled = busy || resolving
  const label = resolving ? 'Resolving…' : busy ? 'Opening…' : 'Open external IDE (dev)'
  const title = resolving
    ? 'Resolving the project folder before opening Shogo IDE'
    : `Open external IDE dev runtime${projectName ? ` for ${projectName}` : ''}`
  const setupLogPath = status?.setupLogPath && !status.launchReady ? status.setupLogPath : null
  const diagnostics = message && !status?.launchReady ? status?.diagnostics ?? [] : []

  return (
    <div className="pointer-events-none absolute right-3 top-3 z-50 flex max-w-[min(26rem,calc(100%-1.5rem))] flex-col items-end gap-2">
      <button
        type="button"
        title={title}
        aria-label={title}
        disabled={disabled}
        onClick={() => void launch()}
        className="pointer-events-auto inline-flex items-center gap-1.5 rounded-lg border border-orange-400/30 bg-[color:var(--ide-panel,#181a20)]/95 px-2.5 py-1.5 text-[11px] font-semibold text-orange-100 shadow-lg shadow-black/30 backdrop-blur transition-colors hover:border-orange-400/60 hover:bg-orange-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy || resolving ? <Loader2 size={13} /> : <ExternalLink size={13} />}
        {label}
      </button>
      {message && (
        <div className="pointer-events-auto max-w-sm rounded-lg border border-[color:var(--ide-border,#2d2d2d)] bg-[color:var(--ide-panel,#181a20)]/95 px-3 py-2 text-[11px] leading-5 text-[color:var(--ide-muted,#9ca3af)] shadow-xl backdrop-blur">
          <div>{message}</div>
          {setupLogPath && <div className="mt-1 text-orange-200">Setup log: {setupLogPath}</div>}
          {diagnostics.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-orange-100/90">
              {diagnostics.map((item) => (
                <li key={item}>• {item}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
