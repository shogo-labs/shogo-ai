// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shogo IDE (Code - OSS) on the desktop: locate the prebuilt server named in
 * the shipped manifest, install it on first use, and prepare the per-workspace
 * profile it runs with. The server itself is built in CI
 * (.github/workflows/shogo-ide-server.yml); nothing here clones, builds or
 * npm-installs Code - OSS on the user's machine (#1989).
 */
import { app } from 'electron'
import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { getDataDir, getProjectRoot } from './paths'
import { loadServerManifest, resolveServerAsset, serverTarget } from './code-oss-server/manifest'
import { defaultInstallRoot, ensureCodeOssServer, type InstallProgress } from './code-oss-server/install'
import { cleanupLegacyCodeOss } from './code-oss-server/legacy-cleanup'
import { serverNodeBinary, type ServerProfile } from './code-oss-server/launch'

export const SHOGO_IDE_DISABLED_UPSTREAM_AI_SETTINGS = {
  'github.copilot.enable': { '*': false },
  'github.copilot.chat.enabled': false,
  'chat.disableAIFeatures': true,
  'chat.agent.enabled': false,
  'chat.agentsControl.enabled': false,
  'chat.extensionTools.enabled': false,
  'chat.plugins.enabled': false,
  'chat.mcp.enabled': false,
  'chat.mcp.discovery.enabled': false,
  'chat.mcp.gallery.enabled': false,
  'chat.restoreLastPanelSession': false,
  'chat.titleBar.signIn.enabled': false,
  'chat.titleBar.openInAgentsWindow.enabled': false,
  'chat.viewSessions.enabled': false,
  'chat.commandCenter.enabled': false,
} as const

function resolveRepoRoot(): string {
  if (process.env.SHOGO_REPO_ROOT) return path.resolve(process.env.SHOGO_REPO_ROOT)
  if (process.env.SHOGO_IDE_REPO_ROOT) return path.resolve(process.env.SHOGO_IDE_REPO_ROOT)
  return getProjectRoot()
}

/** apps/shogo-ide: in the app's resources when packaged, in the repo in dev. */
export function shogoIdeSourceDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath!, 'apps', 'shogo-ide')
    : path.join(resolveRepoRoot(), 'apps', 'shogo-ide')
}

/** Next to main.log (same directory choice as main.ts). */
export function shogoIdeLogPath(): string {
  const logDir = process.platform === 'win32'
    ? path.join(app.getPath('userData'), 'logs')
    : path.join(app.getPath('home'), 'Library', 'Logs', 'Shogo')
  return path.join(logDir, 'shogo-ide.log')
}

export function appendShogoIdeLog(message: string): void {
  try {
    const logPath = shogoIdeLogPath()
    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    // logging must never break opening the IDE
  }
}

let legacyCleanupScheduled = false
function scheduleLegacyCleanup(): void {
  if (legacyCleanupScheduled) return
  legacyCleanupScheduled = true
  setTimeout(() => {
    const removed = cleanupLegacyCodeOss({ tempDir: os.tmpdir(), homeDir: os.homedir(), dataDir: getDataDir() })
    for (const target of removed) appendShogoIdeLog(`Removed leftover from the old Code - OSS setup: ${target}`)
  }, 0)
}

/**
 * The directory of an installed server, downloading and verifying it on
 * first use. `SHOGO_IDE_SERVER_DIR` points at a locally built server instead
 * (see apps/shogo-ide/README.md).
 */
export async function ensureShogoIdeServer(onProgress: (progress: InstallProgress) => void): Promise<string> {
  scheduleLegacyCleanup()
  const override = process.env.SHOGO_IDE_SERVER_DIR?.trim()
  if (override) {
    const dir = path.resolve(override)
    if (!fs.existsSync(serverNodeBinary(dir)) || !fs.existsSync(path.join(dir, 'out', 'server-main.js'))) {
      throw new Error(`SHOGO_IDE_SERVER_DIR=${dir} is not a built Shogo IDE server.`)
    }
    appendShogoIdeLog(`Using the local Shogo IDE server at ${dir}`)
    return dir
  }

  const manifest = loadServerManifest(path.join(shogoIdeSourceDir(), 'code-oss-server.manifest.json'))
  const target = serverTarget()
  if (!target) throw new Error(`Shogo IDE is not available for ${process.platform}-${process.arch} yet.`)
  const asset = resolveServerAsset(manifest, target)
  const installRoot = process.env.SHOGO_IDE_SERVER_INSTALL_ROOT?.trim() || defaultInstallRoot()
  let lastPhase = ''
  const { dir, downloaded } = await ensureCodeOssServer({
    artifactId: manifest.artifactId,
    target,
    asset,
    installRoot,
    onProgress: (progress) => {
      if (progress.phase !== lastPhase) {
        lastPhase = progress.phase
        appendShogoIdeLog(progress.phase === 'downloading' ? `Downloading ${asset.url}` : `Server install: ${progress.phase}`)
      }
      onProgress(progress)
    },
  })
  appendShogoIdeLog(downloaded ? `Installed ${manifest.artifactId} at ${dir}` : `Using installed ${manifest.artifactId} at ${dir}`)
  return dir
}

function runtimeProfileSegment(profileKey: string): string {
  const basename = path.basename(profileKey).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 48) || 'workspace'
  const hash = createHash('sha256').update(path.resolve(profileKey)).digest('hex').slice(0, 12)
  return `${basename}-${hash}`
}

/**
 * The server profile for one workspace. Settings are written both as user
 * settings and as the server's machine settings, which the web client applies
 * for this remote whatever its browser-side user settings hold.
 */
export function ensureShogoIdeRuntimeProfile(profileKey: string, options: { desktopChatUrl?: string } = {}): ServerProfile {
  const profileDir = path.join(getDataDir(), 'shogo-ide', 'profiles', runtimeProfileSegment(profileKey))
  const profile: ServerProfile = {
    profileDir,
    userDataDir: path.join(profileDir, 'user-data'),
    extensionsDir: path.join(profileDir, 'extensions'),
    serverDataDir: path.join(profileDir, 'server-data'),
  }
  const settings = {
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'extensions.autoCheckUpdates': false,
    'extensions.autoUpdate': false,
    'workbench.startupEditor': 'none',
    'security.workspace.trust.enabled': false,
    'workbench.panel.defaultLocation': 'bottom',
    'workbench.secondarySideBar.defaultVisibility': 'visible',
    'workbench.secondarySideBar.showLabels': true,
    ...(options.desktopChatUrl ? { 'shogo.desktopChat.url': options.desktopChatUrl } : {}),
    ...SHOGO_IDE_DISABLED_UPSTREAM_AI_SETTINGS,
  }
  for (const settingsPath of [
    path.join(profile.userDataDir, 'User', 'settings.json'),
    path.join(profile.serverDataDir, 'data', 'Machine', 'settings.json'),
  ]) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
  }
  fs.mkdirSync(profile.extensionsDir, { recursive: true })
  return profile
}
