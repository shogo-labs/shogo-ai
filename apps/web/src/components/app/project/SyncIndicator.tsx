/**
 * SyncIndicator — Desktop-only sync status + toggle for agent projects.
 *
 * Shows a cloud icon with state feedback and a dropdown for sync controls.
 * Only renders when `window.shogoDesktop` is available.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { Cloud, CloudOff, Loader2, AlertTriangle, RefreshCw, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { isDesktop, getDesktopAPI } from '@/lib/desktop'

interface SyncIndicatorProps {
  projectId: string
}

type SyncState = 'idle' | 'syncing' | 'error' | 'disabled'

interface SyncStatus {
  state: SyncState
  lastSyncedAt: number | null
  fileCount: number
  error?: string
}

export function SyncIndicator({ projectId }: SyncIndicatorProps) {
  const [status, setStatus] = useState<SyncStatus>({
    state: 'disabled',
    lastSyncedAt: null,
    fileCount: 0,
  })
  const [open, setOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isDesktop()) return

    const api = getDesktopAPI()

    api.sync.status(projectId).then(setStatus).catch(() => {})

    const unsubscribe = api.sync.onStatus((pid, s) => {
      if (pid === projectId) setStatus(s)
    })

    return unsubscribe
  }, [projectId])

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  if (!isDesktop()) return null

  const handleToggle = async () => {
    const api = getDesktopAPI()
    if (status.state === 'disabled') {
      await api.sync.enable(projectId)
    } else {
      await api.sync.disable(projectId)
    }
  }

  const handleSyncNow = async () => {
    await getDesktopAPI().sync.trigger(projectId)
  }

  const handlePull = async () => {
    await getDesktopAPI().sync.pull(projectId)
  }

  const icon = (() => {
    switch (status.state) {
      case 'syncing':
        return <Loader2 className="h-3.5 w-3.5 animate-spin" />
      case 'error':
        return <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
      case 'disabled':
        return <CloudOff className="h-3.5 w-3.5" />
      case 'idle':
      default:
        return <Cloud className="h-3.5 w-3.5" />
    }
  })()

  const lastSynced = status.lastSyncedAt
    ? new Date(status.lastSyncedAt).toLocaleTimeString()
    : 'Never'

  return (
    <div className="relative" ref={dropdownRef}>
      <Button
        variant="ghost"
        size="icon"
        className={cn(
          'h-8 w-8 text-muted-foreground hover:text-foreground',
          status.state === 'idle' && 'text-foreground',
        )}
        onClick={() => setOpen(!open)}
        title={
          status.state === 'disabled'
            ? 'Cloud sync disabled'
            : status.state === 'syncing'
              ? 'Syncing...'
              : status.state === 'error'
                ? `Sync error: ${status.error}`
                : 'Cloud sync active'
        }
      >
        {icon}
      </Button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-56 rounded-lg border bg-popover p-3 shadow-md">
          <div className="text-xs font-medium mb-2">Cloud Sync</div>

          {/* Toggle */}
          <label className="flex items-center justify-between text-xs mb-2 cursor-pointer">
            <span>Sync to cloud</span>
            <button
              onClick={handleToggle}
              className={cn(
                'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
                status.state !== 'disabled' ? 'bg-primary' : 'bg-muted',
              )}
            >
              <span
                className={cn(
                  'inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform',
                  status.state !== 'disabled' ? 'translate-x-4' : 'translate-x-0.5',
                )}
              />
            </button>
          </label>

          {status.state !== 'disabled' && (
            <>
              <div className="border-t my-2" />
              <div className="text-[11px] text-muted-foreground mb-1.5">
                Last synced: {lastSynced}
              </div>
              <div className="text-[11px] text-muted-foreground mb-2">
                {status.fileCount} files tracked
              </div>

              {status.error && (
                <div className="text-[11px] text-destructive mb-2">
                  {status.error}
                </div>
              )}

              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 text-[11px] flex-1"
                  onClick={handleSyncNow}
                  disabled={status.state === 'syncing'}
                >
                  <RefreshCw className="h-3 w-3 mr-1" />
                  Push
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 text-[11px] flex-1"
                  onClick={handlePull}
                  disabled={status.state === 'syncing'}
                >
                  <Cloud className="h-3 w-3 mr-1" />
                  Pull
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
