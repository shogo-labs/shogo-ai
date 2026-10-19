// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Settings → Data: one archive of the entire workspace, and the import that
 * restores one.
 *
 * The archive is produced server-side (every in-scope model + every project's
 * files) and streamed: web downloads the blob, native streams it through
 * `expo-file-system` because a 500 MB response cannot be held in JS memory.
 * Import always creates a **new** workspace — v1 never merges into an existing
 * one — and the report lists what came across, what did not, and which
 * credentials have to be set again.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Platform, Pressable, TextInput, View } from 'react-native'
import { observer } from 'mobx-react-lite'
import { useActiveWorkspace } from '../../hooks/useActiveWorkspace'
import { useDomainHttp } from '../../contexts/domain'
import { API_URL, api } from '../../lib/api'
import { Button, Card, CardContent, Switch } from '@shogo/shared-ui/primitives'
import { Text } from './account-sheet-chrome'

interface Estimate {
  totals: { rows: number; files: number; bytes: number }
  projects: Array<{ id: string; name: string; files: number; bytes: number }>
  warnings: string[]
  limits: { bytes: number }
}

interface ImportReport {
  workspace: { id: string; name: string; kind: string }
  dryRun: boolean
  stats: {
    rowsInserted: number
    rowsSkipped: number
    filesWritten: number
    attachments: number
  }
  warnings: string[]
  credentials: Array<{ channel: string; field: string; label: string }>
  skippedRows?: Array<{ model: string; id: string; reason: string }>
}

function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** exp).toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`
}

async function pickArchive(): Promise<{ base64: string; name: string; mime: string } | null> {
  if (Platform.OS === 'web') {
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.zip,application/zip'
      input.onchange = async () => {
        const file = input.files?.[0]
        if (!file) return resolve(null)
        const buffer = await file.arrayBuffer()
        const bytes = new Uint8Array(buffer)
        let binary = ''
        const CHUNK = 0x8000
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
        }
        resolve({ base64: btoa(binary), name: file.name, mime: file.type || 'application/zip' })
      }
      input.click()
    })
  }

  const { getDocumentAsync } = await import('expo-document-picker')
  const result = await getDocumentAsync({ type: '*/*', multiple: false, copyToCacheDirectory: true })
  const asset = result.canceled ? null : result.assets?.[0]
  if (!asset) return null
  const { readAsStringAsync, EncodingType } = await import('expo-file-system/legacy')
  const base64 = await readAsStringAsync(asset.uri, { encoding: EncodingType.Base64 })
  return {
    base64,
    name: asset.name || 'workspace.zip',
    mime: asset.mimeType || 'application/zip',
  }
}

function base64ToBlob(base64: string, mime: string, name: string): File {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new File([bytes], name, { type: mime })
}

export const WorkspaceExportSection = observer(function WorkspaceExportSection() {
  const workspace = useActiveWorkspace()
  const http = useDomainHttp()
  const workspaceId = workspace?.id

  const [estimate, setEstimate] = useState<Estimate | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const [includeAttachments, setIncludeAttachments] = useState(true)
  const [includeAllDms, setIncludeAllDms] = useState(false)
  const [password, setPassword] = useState('')
  const [importReport, setImportReport] = useState<ImportReport | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  const loadEstimate = useCallback(async () => {
    if (!workspaceId) return
    try {
      const data = await api.getWorkspaceExportEstimate(http, workspaceId)
      setEstimate(data as Estimate)
      setLoadError(null)
    } catch (err: any) {
      setLoadError(err?.message || 'Could not estimate this workspace.')
    }
  }, [http, workspaceId])

  useEffect(() => {
    void loadEstimate()
  }, [loadEstimate])

  const summary = useMemo(() => {
    if (!estimate) return null
    const { files, rows, bytes } = estimate.totals
    return `${estimate.projects.length} project${estimate.projects.length === 1 ? '' : 's'} · ${files.toLocaleString()} files · ${formatBytes(bytes)} · ${rows.toLocaleString()} rows`
  }, [estimate])

  const onExport = useCallback(async () => {
    if (!workspaceId) return
    setBusy('export')
    try {
      if (Platform.OS === 'web') {
        const res = await fetch(`${API_URL}/api/workspaces/${workspaceId}/export`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            includeAttachments,
            includeAllDms,
            password: password || undefined,
          }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body?.error?.message || `Export failed (${res.status})`)
        }
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = `${workspace?.name || 'workspace'}.shogo-workspace.zip`
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        URL.revokeObjectURL(url)
      } else {
        const { cacheDirectory, downloadAsync } = await import('expo-file-system/legacy')
        if (!cacheDirectory) throw new Error('Could not reach app storage.')
        const url = api.getWorkspaceExportUrl(workspaceId, { includeAllDms, includeAttachments })
        const target = `${cacheDirectory}${Date.now()}-workspace.zip`
        const result = await downloadAsync(url, target, {
          headers: api.getWorkspaceExportHeaders({
            includeAllDms,
            includeAttachments,
            password: password || undefined,
          }),
        })
        if (result.status !== 200) {
          throw new Error(
            result.status === 413
              ? 'This workspace is larger than the export limit for your plan.'
              : `Export failed (${result.status})`,
          )
        }
        const Sharing = await import('expo-sharing')
        await Sharing.shareAsync(result.uri, { dialogTitle: 'Save workspace archive' })
      }
    } catch (err: any) {
      Alert.alert('Export failed', err?.message || 'The workspace could not be exported.')
    } finally {
      setBusy(null)
    }
  }, [workspaceId, workspace?.name, includeAttachments, includeAllDms, password])

  const onImport = useCallback(async () => {
    setImportError(null)
    setImportReport(null)
    setBusy('import')
    try {
      const picked = await pickArchive()
      if (!picked) return
      const file =
        Platform.OS === 'web'
          ? base64ToBlob(picked.base64, picked.mime, picked.name)
          : // React Native has no `File`; pass a name-tagged Blob-shaped object.
            Object.assign(new Blob([Uint8Array.from(atob(picked.base64), (c) => c.charCodeAt(0))]), {
              name: picked.name,
            })
      const report = (await api.importWorkspaceArchive(file, {
        name: `${workspace?.name || 'Workspace'} (imported)`,
        password: password || undefined,
      })) as ImportReport
      setImportReport(report)
      Alert.alert(
        'Workspace imported',
        `${report.workspace.name} is ready: ${report.stats.rowsInserted.toLocaleString()} rows and ${report.stats.filesWritten.toLocaleString()} files.`,
      )
    } catch (err: any) {
      setImportError(err?.message || 'The archive could not be imported.')
    } finally {
      setBusy(null)
    }
  }, [workspace?.name, password])

  if (!workspaceId) return null

  return (
    <View className="gap-4">
      <Card>
        <CardContent className="gap-3 p-4">
          <Text className="text-base font-semibold">Backup &amp; export</Text>
          <Text className="text-sm text-muted-foreground">
            One archive with every project&apos;s files, every chat, channel, board, goal and
            schedule in this workspace. Credentials are left out unless you set a password.
          </Text>
          {summary ? <Text className="text-xs text-muted-foreground">{summary}</Text> : null}
          {loadError ? (
            <Text className="text-xs text-amber-400">{loadError}</Text>
          ) : null}
          {estimate?.warnings?.length ? (
            <Text className="text-xs text-amber-400">{estimate.warnings.join(' ')}</Text>
          ) : null}

          <View className="flex-row items-center justify-between">
            <Text className="text-sm">Include chat attachments</Text>
            <Switch checked={includeAttachments} onCheckedChange={setIncludeAttachments} />
          </View>
          <View className="flex-row items-center justify-between">
            <View className="flex-1 pr-3">
              <Text className="text-sm">Include other members&apos; DMs</Text>
              <Text className="text-xs text-muted-foreground">Owner only</Text>
            </View>
            <Switch checked={includeAllDms} onCheckedChange={setIncludeAllDms} />
          </View>

          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="Optional archive password"
            secureTextEntry
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            placeholderTextColor="#8b8b8b"
          />
          <Text className="text-xs text-muted-foreground">
            With a password, credentials travel inside the archive instead of being redacted.
          </Text>

          <Button
            onPress={onExport}
            disabled={busy !== null}
            className="flex-row items-center justify-center gap-2"
          >
            <Text className="text-sm font-medium text-primary-foreground">
              {busy === 'export' ? 'Building archive…' : 'Export workspace'}
            </Text>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="gap-3 p-4">
          <Text className="text-base font-semibold">Import a workspace</Text>
          <Text className="text-sm text-muted-foreground">
            Restores an archive into a <Text className="font-medium">new</Text> workspace. Members
            are matched by email; rows that reference a person without an account here are listed
            in the report.
          </Text>
          <Button
            variant="outline"
            onPress={onImport}
            disabled={busy !== null}
            className="flex-row items-center justify-center gap-2"
          >
            <Text className="text-sm font-medium">
              {busy === 'import' ? 'Importing…' : 'Choose archive…'}
            </Text>
          </Button>

          {importError ? <Text className="text-xs text-red-400">{importError}</Text> : null}

          {importReport ? (
            <View className="gap-1">
              <Text className="text-sm font-medium">{importReport.workspace.name}</Text>
              <Text className="text-xs text-muted-foreground">
                {importReport.stats.rowsInserted.toLocaleString()} rows ·{' '}
                {importReport.stats.filesWritten.toLocaleString()} files ·{' '}
                {importReport.stats.attachments.toLocaleString()} attachments
                {importReport.stats.rowsSkipped > 0
                  ? ` · ${importReport.stats.rowsSkipped} skipped`
                  : ''}
              </Text>
              {importReport.warnings.slice(0, 4).map((warning) => (
                <Text key={warning} className="text-xs text-amber-400">
                  {warning}
                </Text>
              ))}
              {importReport.credentials.length ? (
                <View className="mt-2 gap-1">
                  <Text className="text-xs font-medium">Set these again after import</Text>
                  {importReport.credentials.slice(0, 8).map((credential) => (
                    <Text key={`${credential.channel}:${credential.field}`} className="text-xs text-muted-foreground">
                      {credential.label || credential.field} — {credential.channel}
                    </Text>
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}
        </CardContent>
      </Card>
    </View>
  )
})
