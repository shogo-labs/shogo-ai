// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { zipSync, strToU8 } from 'fflate'
import { readConfig, getDeviceInfo, type BugReportConfig } from './config'

export interface BugReportAttachment {
  name: string
  dataUrl: string
}

export interface BugReportPayload {
  description: string
  attachments?: BugReportAttachment[]
  /** @deprecated Use attachments instead */
  screenshotBase64?: string
}

export interface SystemInfo {
  appVersion: string
  electronVersion: string
  platform: NodeJS.Platform
  arch: string
  osVersion: string
  nodeVersion: string
  totalMemoryMB: number
  freeMemoryMB: number
  cpuModel: string
  cpuCores: number
  deviceId: string
  deviceName: string
  uptime: number
}

function getLogDir(): string {
  return process.platform === 'win32'
    ? path.join(app.getPath('userData'), 'logs')
    : path.join(app.getPath('home'), 'Library', 'Logs', 'Shogo')
}

function getMainLogPath(): string {
  return path.join(getLogDir(), 'main.log')
}

function tailFile(filePath: string, maxLines: number): string {
  try {
    if (!fs.existsSync(filePath)) return ''
    const content = fs.readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')
    if (lines.length <= maxLines) return content
    return lines.slice(-maxLines).join('\n')
  } catch {
    return `[Error reading ${filePath}]`
  }
}

export function collectSystemInfo(): SystemInfo {
  const device = getDeviceInfo()
  const cpus = os.cpus()
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    osVersion: os.release(),
    nodeVersion: process.versions.node,
    totalMemoryMB: Math.round(os.totalmem() / 1024 / 1024),
    freeMemoryMB: Math.round(os.freemem() / 1024 / 1024),
    cpuModel: cpus[0]?.model || 'unknown',
    cpuCores: cpus.length,
    deviceId: device.id,
    deviceName: device.name,
    uptime: Math.round(os.uptime()),
  }
}

function getRedactedConfig(): Record<string, unknown> {
  const config = readConfig()
  const redacted: Record<string, unknown> = { ...config }
  // Remove any fields that might contain secrets
  const sensitiveKeys = ['githubToken', 'discordWebhookUrl']
  if (typeof redacted.bugReport === 'object' && redacted.bugReport !== null) {
    const br = { ...(redacted.bugReport as Record<string, unknown>) }
    for (const key of sensitiveKeys) {
      if (br[key]) br[key] = '[REDACTED]'
    }
    redacted.bugReport = br
  }
  return redacted
}

export interface BugReportBundle {
  zipBuffer: Uint8Array
  filename: string
}

export function buildBugReportZip(payload: BugReportPayload, maxLogLines?: number): BugReportBundle {
  const lines = maxLogLines ?? readConfig().bugReport?.maxLogLines ?? 500
  const systemInfo = collectSystemInfo()
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')

  const files: Record<string, Uint8Array> = {}

  // User description
  files['description.txt'] = strToU8(payload.description || '(no description provided)')

  // System info
  files['system-info.json'] = strToU8(JSON.stringify(systemInfo, null, 2))

  // Desktop config (redacted)
  files['config.json'] = strToU8(JSON.stringify(getRedactedConfig(), null, 2))

  // Main process log (tail)
  const mainLog = tailFile(getMainLogPath(), lines)
  if (mainLog) {
    files['logs/main.log'] = strToU8(mainLog)
  }

  // API server log — check common locations
  const apiLogCandidates = [
    path.join(getLogDir(), 'api.log'),
    path.join(app.getPath('userData'), 'data', 'api.log'),
  ]
  for (const candidate of apiLogCandidates) {
    const apiLog = tailFile(candidate, lines)
    if (apiLog) {
      files['logs/api.log'] = strToU8(apiLog)
      break
    }
  }

  // User-attached files (screenshots, videos, etc.)
  if (payload.attachments && payload.attachments.length > 0) {
    for (const attachment of payload.attachments) {
      const match = attachment.dataUrl.match(/^data:[^;]+;base64,(.+)$/)
      if (match) {
        files[`attachments/${attachment.name}`] = Buffer.from(match[1], 'base64')
      }
    }
  }

  // Legacy screenshot support
  if (payload.screenshotBase64) {
    files['screenshot.png'] = Buffer.from(payload.screenshotBase64, 'base64')
  }

  const zipBuffer = zipSync(files, { level: 6 })
  const filename = `shogo-bug-report-${timestamp}.zip`

  return { zipBuffer, filename }
}

export async function submitToDiscord(
  webhookUrl: string,
  payload: BugReportPayload,
  bundle: BugReportBundle,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const systemInfo = collectSystemInfo()
    const embed = {
      title: 'Bug Report',
      description: payload.description.slice(0, 2000),
      color: 0xff3b30,
      fields: [
        { name: 'App Version', value: systemInfo.appVersion, inline: true },
        { name: 'Platform', value: `${systemInfo.platform} (${systemInfo.arch})`, inline: true },
        { name: 'OS', value: systemInfo.osVersion, inline: true },
        { name: 'Device', value: systemInfo.deviceName, inline: true },
      ],
      timestamp: new Date().toISOString(),
    }

    const boundary = `----BugReport${Date.now()}`
    const parts: Buffer[] = []

    // JSON payload part
    const jsonPart = JSON.stringify({ embeds: [embed] })
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\nContent-Type: application/json\r\n\r\n${jsonPart}\r\n`
    ))

    // File attachment part
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="files[0]"; filename="${bundle.filename}"\r\nContent-Type: application/zip\r\n\r\n`
    ))
    parts.push(Buffer.from(bundle.zipBuffer))
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))

    const body = Buffer.concat(parts)

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, error: `Discord returned HTTP ${res.status}: ${text.slice(0, 200)}` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error)?.message || 'Discord submission failed' }
  }
}

export async function submitToGitHub(
  repo: string,
  token: string,
  payload: BugReportPayload,
): Promise<{ ok: boolean; error?: string; issueUrl?: string }> {
  try {
    const systemInfo = collectSystemInfo()
    const body = [
      '## Description',
      '',
      payload.description,
      '',
      '## System Info',
      '',
      '| Field | Value |',
      '|-------|-------|',
      `| App Version | ${systemInfo.appVersion} |`,
      `| Platform | ${systemInfo.platform} (${systemInfo.arch}) |`,
      `| OS | ${systemInfo.osVersion} |`,
      `| Electron | ${systemInfo.electronVersion} |`,
      `| Memory | ${systemInfo.freeMemoryMB}MB free / ${systemInfo.totalMemoryMB}MB total |`,
      `| CPU | ${systemInfo.cpuModel} (${systemInfo.cpuCores} cores) |`,
      `| Device | ${systemInfo.deviceName} |`,
      '',
      '_Logs attached in the zip bundle (if exported separately)._',
    ].join('\n')

    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        title: `[Bug Report] ${payload.description.split('\n')[0].slice(0, 80)}`,
        body,
        labels: ['bug', 'user-reported'],
      }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return { ok: false, error: `GitHub returned HTTP ${res.status}: ${text.slice(0, 200)}` }
    }
    const data = (await res.json()) as { html_url?: string }
    return { ok: true, issueUrl: data.html_url }
  } catch (err) {
    return { ok: false, error: (err as Error)?.message || 'GitHub submission failed' }
  }
}
