// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { app } from 'electron'
import { spawn, spawnSync } from 'child_process'
import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import { getBunPath, getDataDir, getProjectRoot } from './paths'

export interface ShogoIdeStatus {
  ok: true
  phase: 6
  workspacePath: string
  productTemplatePath: string
  extensionManifestPath: string
  generatedProductPath: string
  hardeningReportPath: string
  productTemplateExists: boolean
  extensionManifestExists: boolean
  generatedProductExists: boolean
  hardeningReportExists: boolean
  codeOssCheckoutPath: string
  codeOssCheckoutExists: boolean
  executablePath: string | null
  executableExists: boolean
  executableExecutable: boolean
  devRunnerPath: string | null
  devRunnerExists: boolean
  devRunnerExecutable: boolean
  launchPath: string | null
  launchMode: 'packaged' | 'source-runner' | null
  launchReady: boolean
  reason: string
  diagnostics: string[]
  setupInProgress: boolean
  setupLogPath: string
  autoSetupAvailable: boolean
  cloneCommand: string
}


const CODE_OSS_NODE_VERSION = '24.15.0'
export const SHOGO_IDE_DISABLED_UPSTREAM_EXTENSIONS = [
  'GitHub.copilot',
  'GitHub.copilot-chat',
  'vscode.github',
  'vscode.github-authentication',
  'vscode.microsoft-authentication',
  'shogo.shogo-agent-chat',
] as const
const SHOGO_IDE_DISABLED_UPSTREAM_AI_SETTINGS = {
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

let setupPromise: Promise<void> | null = null
function resolveRepoRoot(): string {
  if (process.env.SHOGO_REPO_ROOT) return path.resolve(process.env.SHOGO_REPO_ROOT)
  if (process.env.SHOGO_IDE_REPO_ROOT) return path.resolve(process.env.SHOGO_IDE_REPO_ROOT)
  return getProjectRoot()
}

const PACKAGED_SHOGO_IDE_REQUIRED_FILES = [
  'package.json',
  'product.shogo.template.json',
  path.join('scripts', 'materialize-distribution.mjs'),
  path.join('distribution', 'generated', 'product.json'),
  path.join('hardening', 'generated', 'production-readiness.json'),
  path.join('extensions', 'shogo-core', 'package.json'),
] as const

function copyPackagedShogoIdeWorkspace(sourcePath: string, targetPath: string): void {
  fs.mkdirSync(targetPath, { recursive: true })
  fs.cpSync(sourcePath, targetPath, {
    recursive: true,
    force: true,
    filter: (source) => {
      const relative = path.relative(sourcePath, source)
      if (!relative) return true
      const parts = relative.split(path.sep)
      return parts[0] !== 'node_modules' && parts[0] !== 'upstream' && parts[0] !== '.git'
    },
  })
}

function getPackagedShogoIdeSourcePath(): string {
  return path.join(process.resourcesPath!, 'apps', 'shogo-ide')
}

function ensurePackagedShogoIdeWorkspace(): string {
  const sourcePath = getPackagedShogoIdeSourcePath()
  const targetPath = path.join(getDataDir(), 'shogo-ide')
  const missingSourceFiles = PACKAGED_SHOGO_IDE_REQUIRED_FILES.filter((file) => !fs.existsSync(path.join(sourcePath, file)))
  if (missingSourceFiles.length > 0) {
    throw new Error(`Packaged Shogo IDE resources are incomplete. Missing: ${missingSourceFiles.map((file) => `apps/shogo-ide/${file}`).join(', ')}`)
  }

  const sourcePackage = JSON.parse(fs.readFileSync(path.join(sourcePath, 'package.json'), 'utf8')) as { version?: string }
  const markerPath = path.join(targetPath, '.shogo-packaged-source.json')
  const expectedMarker = JSON.stringify({ appVersion: app.getVersion(), shogoIdeVersion: sourcePackage.version ?? 'unknown' })
  let currentMarker = ''
  try {
    currentMarker = fs.readFileSync(markerPath, 'utf8').trim()
  } catch {
    currentMarker = ''
  }

  const missingTargetFiles = PACKAGED_SHOGO_IDE_REQUIRED_FILES.some((file) => !fs.existsSync(path.join(targetPath, file)))
  if (currentMarker !== expectedMarker || missingTargetFiles) {
    copyPackagedShogoIdeWorkspace(sourcePath, targetPath)
    fs.writeFileSync(markerPath, `${expectedMarker}\n`)
  }

  return targetPath
}

function resolveShogoIdeWorkspacePath(): string {
  if (process.env.SHOGO_IDE_WORKSPACE_PATH) return path.resolve(process.env.SHOGO_IDE_WORKSPACE_PATH)
  if (app.isPackaged) return ensurePackagedShogoIdeWorkspace()
  return path.join(resolveRepoRoot(), 'apps', 'shogo-ide')
}

function resolveSetupCwd(): string {
  return app.isPackaged ? getDataDir() : resolveRepoRoot()
}

function pathNeedsNativeBuildWorkaround(candidate: string): boolean {
  return /[\s'"\\]/.test(candidate)
}

function resolveCodeOssCheckoutPath(workspacePath: string): string {
  const defaultPath = path.join(workspacePath, 'upstream', 'vscode')
  if (process.env.SHOGO_CODE_OSS_CHECKOUT_PATH) return path.resolve(process.env.SHOGO_CODE_OSS_CHECKOUT_PATH)
  if (!pathNeedsNativeBuildWorkaround(defaultPath)) return defaultPath

  const hash = createHash('sha256').update(defaultPath).digest('hex').slice(0, 12)
  const homePath = path.join(app.getPath('home'), '.shogo', 'code-oss', hash, 'vscode')
  if (!pathNeedsNativeBuildWorkaround(homePath)) return homePath

  return path.join(app.getPath('temp'), 'shogo-codeoss-checkouts', hash, 'vscode')
}

function firstExistingPath(paths: string[]): string | null {
  for (const candidate of paths) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  return null
}

function resolveSetupLogPath(workspacePath: string): string {
  return path.join(workspacePath, 'hardening', 'generated', 'auto-setup.log')
}

function appendSetupLog(workspacePath: string, message: string): void {
  const logPath = resolveSetupLogPath(workspacePath)
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`)
}

function setupCommandEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
  const pathSep = process.platform === 'win32' ? ';' : ':'
  const bunPath = getBunPath()
  const bunDir = path.isAbsolute(bunPath) ? path.dirname(bunPath) : null
  const defaultPaths = process.platform === 'win32'
    ? []
    : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  const existingPath = env[pathKey] || env.PATH || env.Path || ''
  const pathEntries = [bunDir, ...defaultPaths, ...existingPath.split(pathSep)]
    .filter((entry): entry is string => !!entry)
  env[pathKey] = Array.from(new Set(pathEntries)).join(pathSep)
  env.PATH = env[pathKey]
  env.SHOGO_BUN_PATH = bunPath
  if (!env.HOME && process.platform !== 'win32') env.HOME = app.getPath('home')
  return env
}

function resolveSetupCommand(command: string): string {
  if (command !== 'bun') return command
  const bunPath = getBunPath()
  return path.isAbsolute(bunPath) && fs.existsSync(bunPath) ? bunPath : command
}

function runSetupCommand(workspacePath: string, command: string, args: string[], cwd: string): Promise<void> {
  const resolvedCommand = resolveSetupCommand(command)
  appendSetupLog(workspacePath, `$ ${[command, ...args].join(' ')}`)
  return new Promise((resolve, reject) => {
    const child = spawn(resolvedCommand, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: setupCommandEnv() })
    child.stdout.on('data', (chunk) => appendSetupLog(workspacePath, String(chunk).trimEnd()))
    child.stderr.on('data', (chunk) => appendSetupLog(workspacePath, String(chunk).trimEnd()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 'unknown'}`))
      }
    })
  })
}

function isNpmCliPath(candidate: string | undefined): candidate is string {
  return !!candidate && path.basename(candidate) === 'npm-cli.js' && fs.existsSync(candidate)
}

function resolveNpmCliPath(): string | null {
  const globalNpmRoot = spawnSync('npm', ['root', '-g'], {
    encoding: 'utf8',
    timeout: 5_000,
    env: setupCommandEnv(),
  })

  const candidates = [
    process.env.SHOGO_CODE_OSS_NPM_CLI,
    process.env.npm_execpath,
    globalNpmRoot.status === 0 ? path.join(globalNpmRoot.stdout.trim(), 'npm', 'bin', 'npm-cli.js') : undefined,
    '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
  ].filter(isNpmCliPath)

  return firstExistingPath(candidates)
}

function resolveCodeOssInstallCommand(): { command: string; args: string[] } {
  const currentMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10)
  if (currentMajor === 24) return { command: 'npm', args: ['install'] }

  const npmCliPath = resolveNpmCliPath()
  if (npmCliPath && process.platform !== 'win32') {
    return {
      command: 'npx',
      args: ['-y', '-p', `node@${CODE_OSS_NODE_VERSION}`, 'node', npmCliPath, 'install'],
    }
  }

  return { command: 'npm', args: ['install'] }
}

function resolveCodeOssInstallCwd(workspacePath: string, codeOssCheckoutPath: string): string {
  if (!pathNeedsNativeBuildWorkaround(codeOssCheckoutPath)) return codeOssCheckoutPath

  const hash = createHash('sha256').update(codeOssCheckoutPath).digest('hex').slice(0, 12)
  const linkPath = path.join(app.getPath('temp'), `shogo-codeoss-${hash}`)
  try {
    const stat = fs.lstatSync(linkPath)
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(linkPath)
      if (path.resolve(path.dirname(linkPath), target) === codeOssCheckoutPath) return linkPath
      fs.unlinkSync(linkPath)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  fs.symlinkSync(codeOssCheckoutPath, linkPath, 'dir')
  appendSetupLog(workspacePath, `Using no-space Code OSS install path: ${linkPath}`)
  return linkPath
}

function codeOssDependenciesInstalled(codeOssCheckoutPath: string): boolean {
  return fs.existsSync(path.join(codeOssCheckoutPath, 'node_modules', '@vscode', 'sqlite3', 'build', 'Release'))
    && fs.existsSync(path.join(codeOssCheckoutPath, 'node_modules', 'node-addon-api'))
}

export function syncShogoIdeProduct(status: ShogoIdeStatus): void {
  if (!fs.existsSync(status.generatedProductPath) || !fs.existsSync(status.codeOssCheckoutPath)) return
  const targetProductPath = path.join(status.codeOssCheckoutPath, 'product.json')
  if (!fs.existsSync(targetProductPath)) return

  const product = JSON.parse(fs.readFileSync(targetProductPath, 'utf8'))
  const generatedProduct = JSON.parse(fs.readFileSync(status.generatedProductPath, 'utf8'))
  for (const key of [
    'nameShort',
    'nameLong',
    'applicationName',
    'dataFolderName',
    'serverDataFolderName',
    'urlProtocol',
    'licenseName',
    'licenseUrl',
    'quality',
    'documentationUrl',
    'reportIssueUrl',
    'requestFeatureUrl',
    'privacyStatementUrl',
    'telemetryOptOutUrl',
    'extensionsGallery',
    'linkProtectionTrustedDomains',
    'enableTelemetry',
    'extensionEnabledApiProposals',
    'aiConfig',
  ] as const) {
    if (generatedProduct[key] !== undefined) product[key] = generatedProduct[key]
  }
  product.builtInExtensions = []
  delete product.defaultChatAgent
  delete product.trustedExtensionAuthAccess
  if (Array.isArray(product.builtInExtensionsEnabledWithAutoUpdates)) {
    product.builtInExtensionsEnabledWithAutoUpdates = product.builtInExtensionsEnabledWithAutoUpdates.filter((id: string) => id !== 'GitHub.copilot-chat' && id !== 'GitHub.copilot')
  } else {
    product.builtInExtensionsEnabledWithAutoUpdates = []
  }
  fs.writeFileSync(targetProductPath, `${JSON.stringify(product, null, '\t')}\n`)
}

function syncFilteredSystemExtensions(sourceExtensionsDir: string, targetExtensionsDir: string): void {
  const blocked = new Set(['copilot', 'copilot-chat'])
  fs.rmSync(targetExtensionsDir, { recursive: true, force: true })
  fs.mkdirSync(targetExtensionsDir, { recursive: true })
  if (!fs.existsSync(sourceExtensionsDir)) return

  for (const entry of fs.readdirSync(sourceExtensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || blocked.has(entry.name.toLowerCase())) continue
    const sourcePath = path.join(sourceExtensionsDir, entry.name)
    const targetPath = path.join(targetExtensionsDir, entry.name)
    try {
      fs.symlinkSync(sourcePath, targetPath, 'dir')
    } catch {
      fs.cpSync(sourcePath, targetPath, { recursive: true })
    }
  }
}

function ensureBundledExtensionBuilt(workspacePath: string, sourcePath: string, manifest: { main?: string; browser?: string; scripts?: Record<string, string> }): void {
  const expectedOutputs = [manifest.main, manifest.browser]
    .filter((entry): entry is string => !!entry && !entry.startsWith('../'))
    .map((entry) => path.join(sourcePath, entry))

  if (expectedOutputs.length === 0 || expectedOutputs.every((entry) => fs.existsSync(entry))) return
  if (!manifest.scripts?.build) return

  appendSetupLog(workspacePath, `Building bundled extension: ${sourcePath}`)
  const result = spawnSync('npm', ['run', 'build'], { cwd: sourcePath, encoding: 'utf8', env: setupCommandEnv() })
  if (result.stdout) appendSetupLog(workspacePath, result.stdout.trimEnd())
  if (result.stderr) appendSetupLog(workspacePath, result.stderr.trimEnd())
  if (result.status !== 0) {
    throw new Error(`npm run build exited with code ${result.status ?? 'unknown'} in ${sourcePath}`)
  }
}

function syncBundledExtension(workspacePath: string, extensionsDir: string, extensionName: string): void {
  const sourcePath = path.join(workspacePath, 'extensions', extensionName)
  const manifestPath = path.join(sourcePath, 'package.json')
  if (!fs.existsSync(manifestPath)) return
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  ensureBundledExtensionBuilt(workspacePath, sourcePath, manifest)
  const publisher = manifest.publisher || 'shogo'
  const version = manifest.version || '0.0.0'
  const targetPath = path.join(extensionsDir, `${publisher}.${extensionName}-${version}`)
  fs.cpSync(sourcePath, targetPath, { recursive: true, force: true })
}

function syncBundledShogoExtensions(workspacePath: string, extensionsDir: string): void {
  syncBundledExtension(workspacePath, extensionsDir, 'shogo-core')
}

function runtimeProfileSegment(profileKey?: string): string {
  if (!profileKey) return 'default'
  const basename = path.basename(profileKey).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 48) || 'workspace'
  const hash = createHash('sha256').update(path.resolve(profileKey)).digest('hex').slice(0, 12)
  return `${basename}-${hash}`
}

export function ensureShogoIdeRuntimeProfile(workspacePath: string, options: { desktopChatUrl?: string; profileKey?: string } = {}): {
  userDataDir: string
  extensionsDir: string
  systemExtensionsDir: string
  agentsUserDataDir: string
  agentsExtensionsDir: string
  crashReporterDirectory: string
} {
  const runtimeDir = path.join(workspacePath, 'hardening', 'runtime-shogo-ide', runtimeProfileSegment(options.profileKey))
  const userDataDir = path.join(runtimeDir, 'user-data')
  const extensionsDir = path.join(runtimeDir, 'extensions')
  const systemExtensionsDir = path.join(runtimeDir, 'system-extensions')
  const agentsUserDataDir = path.join(runtimeDir, 'agents-user-data')
  const agentsExtensionsDir = path.join(runtimeDir, 'agents-extensions')
  const crashReporterDirectory = path.join(runtimeDir, 'crash-reports')

  for (const dir of [userDataDir, extensionsDir, systemExtensionsDir, agentsUserDataDir, agentsExtensionsDir, crashReporterDirectory]) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const settingsDir = path.join(userDataDir, 'User')
  fs.mkdirSync(settingsDir, { recursive: true })
  const settingsPath = path.join(settingsDir, 'settings.json')
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
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
  fs.rmSync(extensionsDir, { recursive: true, force: true })
  fs.mkdirSync(extensionsDir, { recursive: true })
  const codeOssCheckoutPath = resolveCodeOssCheckoutPath(workspacePath)
  syncFilteredSystemExtensions(path.join(codeOssCheckoutPath, 'extensions'), systemExtensionsDir)
  syncBundledShogoExtensions(workspacePath, extensionsDir)

  return { userDataDir, extensionsDir, systemExtensionsDir, agentsUserDataDir, agentsExtensionsDir, crashReporterDirectory }
}

export async function ensureShogoIdeSetup(status: ShogoIdeStatus): Promise<void> {
  if (setupPromise) return setupPromise

  setupPromise = (async () => {
    appendSetupLog(status.workspacePath, 'Starting automatic Shogo IDE setup.')
    fs.mkdirSync(path.dirname(status.codeOssCheckoutPath), { recursive: true })

    if (!fs.existsSync(status.codeOssCheckoutPath)) {
      await runSetupCommand(status.workspacePath, 'git', [
        'clone',
        '--depth',
        '1',
        'https://github.com/microsoft/vscode.git',
        status.codeOssCheckoutPath,
      ], resolveSetupCwd())
    }

    if (!fs.existsSync(status.generatedProductPath)) {
      await runSetupCommand(status.workspacePath, 'bun', ['run', 'distribution:materialize'], status.workspacePath)
    }

    if (!fs.existsSync(status.hardeningReportPath)) {
      await runSetupCommand(status.workspacePath, 'bun', ['run', 'hardening:report'], status.workspacePath)
    }

    if (fs.existsSync(status.codeOssCheckoutPath) && !codeOssDependenciesInstalled(status.codeOssCheckoutPath)) {
      const installCommand = resolveCodeOssInstallCommand()
      const installCwd = resolveCodeOssInstallCwd(status.workspacePath, status.codeOssCheckoutPath)
      await runSetupCommand(status.workspacePath, installCommand.command, installCommand.args, installCwd)
    }

    appendSetupLog(status.workspacePath, 'Automatic Shogo IDE setup finished.')
  })().finally(() => {
    setupPromise = null
  })

  return setupPromise
}

export function getShogoIdeStatus(): ShogoIdeStatus {
  const workspacePath = resolveShogoIdeWorkspacePath()
  const productTemplatePath = path.join(workspacePath, 'product.shogo.template.json')
  const extensionManifestPath = path.join(workspacePath, 'extensions', 'shogo-core', 'package.json')
  const generatedProductPath = path.join(workspacePath, 'distribution', 'generated', 'product.json')
  const hardeningReportPath = path.join(workspacePath, 'hardening', 'generated', 'production-readiness.json')
  const codeOssCheckoutPath = resolveCodeOssCheckoutPath(workspacePath)
  const setupLogPath = resolveSetupLogPath(workspacePath)
  const executablePath: string | null = null
  const devRunnerPath: string | null = null
  const productTemplateExists = fs.existsSync(productTemplatePath)
  const extensionManifestExists = fs.existsSync(extensionManifestPath)
  const generatedProductExists = fs.existsSync(generatedProductPath)
  const hardeningReportExists = fs.existsSync(hardeningReportPath)
  const codeOssCheckoutExists = fs.existsSync(codeOssCheckoutPath)
  const codeOssDependenciesExist = codeOssCheckoutExists && codeOssDependenciesInstalled(codeOssCheckoutPath)
  const executableExists = false
  const executableExecutable = false
  const devRunnerExists = false
  const devRunnerExecutable = false
  const launchPath: string | null = null
  const launchMode: 'packaged' | 'source-runner' | null = null
  const setupInProgress = !!setupPromise
  const autoSetupAvailable = true
  const launchReady = productTemplateExists && extensionManifestExists && generatedProductExists && hardeningReportExists && codeOssCheckoutExists && codeOssDependenciesExist
  const diagnostics: string[] = []

  if (!productTemplateExists) diagnostics.push('Missing Shogo product template.')
  if (!extensionManifestExists) diagnostics.push('Missing shogo-core extension manifest.')
  if (!generatedProductExists) diagnostics.push('Missing generated Code OSS product metadata; Shogo Desktop will materialize it automatically.')
  if (!hardeningReportExists) diagnostics.push('Missing production-readiness report; Shogo Desktop will generate it automatically.')
  if (!codeOssCheckoutExists) diagnostics.push('Code - OSS checkout is not present; Shogo Desktop will clone it automatically.')
  if (codeOssCheckoutExists && !codeOssDependenciesExist) diagnostics.push('Code - OSS dependencies are not fully installed; Shogo Desktop will install them automatically.')

  const reason = launchReady
    ? 'Shogo IDE web workbench is ready.'
    : setupInProgress
      ? 'Shogo IDE setup is running automatically.'
      : diagnostics[0] ?? 'Shogo IDE is preparing automatically.'

  return {
    ok: true,
    phase: 6,
    workspacePath,
    productTemplatePath,
    extensionManifestPath,
    generatedProductPath,
    hardeningReportPath,
    productTemplateExists,
    extensionManifestExists,
    generatedProductExists,
    hardeningReportExists,
    codeOssCheckoutPath,
    codeOssCheckoutExists,
    executablePath,
    executableExists,
    executableExecutable,
    devRunnerPath,
    devRunnerExists,
    devRunnerExecutable,
    launchPath,
    launchMode,
    launchReady,
    reason,
    diagnostics,
    setupInProgress,
    setupLogPath,
    autoSetupAvailable,
    cloneCommand: `git clone --depth 1 https://github.com/microsoft/vscode.git ${codeOssCheckoutPath}`,
  }
}
