import { useEffect, useRef, useState } from 'react'
import { Code2, ExternalLink, Loader2 } from 'lucide-react-native'

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
  onOpenLegacy,
}: {
  projectName?: string | null
  projectRoot?: string | null
  onOpenLegacy(): void
}) {
  const [bridge] = useState(() => getShogoIdeBridge())
  const [status, setStatus] = useState<ShogoIdeStatus | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const autoLaunchStarted = useRef(false)

  const launch = async (mode: 'auto' | 'manual' = 'manual') => {
    if (!bridge) return
    setBusy(true)
    setMessage(mode === 'auto' ? 'Preparing Shogo IDE…' : null)
    try {
      const result = await bridge.launch(projectRoot ? { workspacePath: projectRoot } : undefined)
      setStatus(result.status)
      if (result.ok) {
        setMessage(result.status.launchMode === 'source-runner' ? 'Opening Shogo IDE from the Code OSS source runner…' : 'Opening Shogo IDE…')
      } else {
        setMessage(result.error || result.status.reason)
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (!bridge) return
    let cancelled = false
    bridge.getStatus()
      .then((nextStatus) => {
        if (cancelled) return
        setStatus(nextStatus)
        if (!autoLaunchStarted.current) {
          autoLaunchStarted.current = true
          void launch('auto')
        }
      })
      .catch((error) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : String(error))
      })
    return () => { cancelled = true }
  }, [bridge])

  if (!bridge) return null

  const readyLabel = busy || status?.setupInProgress ? 'Preparing automatically' : status?.launchReady ? 'Opening' : 'Preparing'
  const setupReason = status?.reason ?? 'Checking Shogo IDE distribution status…'
  const diagnostics = status?.launchReady ? [] : status?.diagnostics ?? []

  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-[color:var(--ide-bg,#0f1115)] p-6 text-[color:var(--ide-text,#d4d4d4)]">
      <div className="w-full max-w-3xl overflow-hidden rounded-2xl border border-[color:var(--ide-border,#2d2d2d)] bg-[color:var(--ide-panel,#181a20)] shadow-2xl">
        <div className="border-b border-[color:var(--ide-border,#2d2d2d)] bg-gradient-to-br from-orange-500/20 via-transparent to-transparent p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-orange-500 text-lg font-bold text-white shadow-lg shadow-orange-950/30">⌘</span>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.22em] text-orange-300">Desktop IDE</p>
                  <h2 className="text-2xl font-semibold text-[color:var(--ide-text-strong,#fff)]">Opening Shogo IDE</h2>
                </div>
              </div>
              <p className="mt-4 max-w-2xl text-sm leading-6 text-[color:var(--ide-muted,#9ca3af)]">
                Shogo Desktop opens the Code OSS-based Shogo IDE automatically for {projectName || 'this project'}. Web and mobile keep using the existing Monaco path and never enter this Desktop-only launcher.
              </p>
            </div>
            <span className="rounded-full border border-[color:var(--ide-border,#2d2d2d)] px-3 py-1 text-xs font-medium text-[color:var(--ide-muted,#9ca3af)]">
              {readyLabel}
            </span>
          </div>
        </div>

        <div className="grid gap-4 p-6 md:grid-cols-[1fr_260px]">
          <div className="space-y-4">
            <div className="rounded-xl border border-[color:var(--ide-border,#2d2d2d)] bg-[color:var(--ide-bg,#0f1115)] p-4">
              <div className="flex items-start gap-3">
                <Code2 size={20} color="#fb923c" />
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-[color:var(--ide-text-strong,#fff)]">Distribution status</h3>
                  <p className="mt-1 text-sm leading-6 text-[color:var(--ide-muted,#9ca3af)]">{setupReason}</p>
                  {message && (
                    <p className="mt-3 rounded-lg border border-[color:var(--ide-border,#2d2d2d)] bg-[color:var(--ide-panel,#181a20)] px-3 py-2 text-xs leading-5 text-[color:var(--ide-muted,#9ca3af)]">
                      {message}
                    </p>
                  )}
                  {diagnostics.length > 0 && (
                    <ul className="mt-3 space-y-1 rounded-lg border border-[color:var(--ide-border,#2d2d2d)] bg-[color:var(--ide-panel,#181a20)] px-3 py-2 text-xs leading-5 text-[color:var(--ide-muted,#9ca3af)]">
                      {diagnostics.map((item) => (
                        <li key={item}>• {item}</li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>

            {status?.setupLogPath && !status.launchReady && (
              <div className="rounded-xl border border-orange-500/30 bg-orange-500/10 p-4 text-xs leading-5 text-orange-100">
                Shogo Desktop is handling setup automatically. Diagnostic log: {status.setupLogPath}
              </div>
            )}
          </div>

          <div className="space-y-3">
            <button
              type="button"
              disabled={busy || !status}
              onClick={() => void launch('manual')}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-orange-500 px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? <Loader2 size={16} /> : <ExternalLink size={16} />}
              {busy ? 'Preparing…' : 'Open Shogo IDE'}
            </button>
            <button
              type="button"
              onClick={onOpenLegacy}
              className="w-full rounded-xl border border-[color:var(--ide-border,#2d2d2d)] px-4 py-3 text-sm font-medium text-[color:var(--ide-muted,#9ca3af)] transition-colors hover:bg-[color:var(--ide-bg,#0f1115)]"
            >
              Use Legacy Monaco IDE
            </button>
            <p className="text-center text-[11px] leading-4 text-[color:var(--ide-muted,#9ca3af)]">
              Legacy mode is a Desktop-only fallback. Web and mobile keep their existing IDE behavior.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
