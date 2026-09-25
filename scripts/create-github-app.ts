#!/usr/bin/env bun
/**
 * Create a Shogo GitHub App from GitHub's App Manifest flow and store its
 * credentials in the repository's GitHub Actions environment secrets.
 *
 * This intentionally keeps the manifest-registration handshake local. The
 * browser is only redirected to GitHub; the temporary conversion code is
 * received by this short-lived localhost server and is never committed.
 *
 * Usage:
 *   bun scripts/create-github-app.ts --env staging
 *   bun scripts/create-github-app.ts --env production --org shogo-labs
 */

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

type TargetEnvironment = 'staging' | 'production'

interface AppManifest {
  name: string
  url: string
  redirect_url: string
  callback_urls: string[]
  hook_attributes: {
    url: string
    active: boolean
  }
  public: boolean
  default_permissions: Record<string, string>
  default_events: string[]
}

interface ConversionResponse {
  id: number
  slug: string
  client_id: string
  client_secret: string
  pem: string
  webhook_secret: string | null
}

const GITHUB_API_VERSION = '2022-11-28'
const DEFAULT_ORG = 'shogo-labs'
const DEFAULT_PORT = 0
const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000

const targetConfig: Record<
  TargetEnvironment,
  { appName: string; domain: string; environments: string[] }
> = {
  staging: {
    appName: 'Shogo AI Staging',
    domain: 'studio.staging.shogo.ai',
    environments: ['staging'],
  },
  production: {
    appName: 'Shogo AI',
    domain: 'studio.shogo.ai',
    environments: ['production-us', 'production-eu'],
  },
}

function usage(exitCode = 1): never {
  const message =
    'Usage: bun scripts/create-github-app.ts --env staging|production [--org shogo-labs] [--repo owner/name]'
  if (exitCode === 0) console.log(message)
  else console.error(message)
  process.exit(exitCode)
}

function parseArgs(): {
  environment: TargetEnvironment
  org: string
  repo?: string
} {
  const args = Bun.argv.slice(2)
  let environment: TargetEnvironment | undefined
  let org = DEFAULT_ORG
  let repo: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--env') {
      const value = args[++index]
      if (value === 'staging' || value === 'production') environment = value
      else usage()
    } else if (arg === '--org') {
      org = args[++index] || usage()
      if (!/^[A-Za-z0-9_.-]+$/.test(org)) {
        throw new Error(`Invalid GitHub organization name: ${org}`)
      }
    } else if (arg === '--repo') {
      repo = args[++index] || usage()
      if (!/^[^/]+\/[^/]+$/.test(repo)) {
        throw new Error(`Expected --repo in owner/name format: ${repo}`)
      }
    } else if (arg === '--help' || arg === '-h') {
      usage(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  if (!environment) usage()
  return { environment, org, repo }
}

function randomToken(): string {
  return randomUUID()
}

function htmlEscape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!,
  )
}

function registrationPage(
  registrationUrl: string,
  manifest: AppManifest,
  state: string,
): string {
  const manifestValue = htmlEscape(JSON.stringify(manifest))
  const stateValue = htmlEscape(state)
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Create Shogo GitHub App</title></head>
  <body>
    <p>Opening GitHub's app creation page…</p>
    <form id="app-manifest" action="${htmlEscape(registrationUrl)}" method="post">
      <input type="hidden" name="manifest" value="${manifestValue}">
      <input type="hidden" name="state" value="${stateValue}">
      <noscript><button type="submit">Continue to GitHub</button></noscript>
    </form>
    <script>document.getElementById('app-manifest').submit()</script>
  </body>
</html>`
}

function callbackResultPage(message: string, success: boolean): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>GitHub App setup</title></head>
  <body>
    <p>${htmlEscape(message)}</p>
    <p>${success ? 'You can close this tab.' : 'Return to the terminal for details.'}</p>
  </body>
</html>`
}

async function waitForManifestCode(
  registrationUrl: string,
  state: string,
  createManifest: (callbackUrl: string) => AppManifest,
): Promise<string> {
  let resolveCode!: (code: string) => void
  let rejectCode!: (error: Error) => void
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })

  let manifest: AppManifest
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: DEFAULT_PORT,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/') {
        return new Response(registrationPage(registrationUrl, manifest, state), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }

      if (url.pathname !== '/callback') {
        return new Response('Not found', { status: 404 })
      }

      const returnedState = url.searchParams.get('state')
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      if (returnedState !== state) {
        const stateError = new Error('GitHub App callback state did not match')
        rejectCode(stateError)
        return new Response(callbackResultPage(stateError.message, false), {
          status: 400,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }
      if (error || !code) {
        const callbackError = new Error(
          `GitHub did not return an app conversion code${error ? `: ${error}` : ''}`,
        )
        rejectCode(callbackError)
        return new Response(callbackResultPage(callbackError.message, false), {
          status: 400,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }

      resolveCode(code)
      return new Response(
        callbackResultPage('GitHub App registration received.', true),
        { headers: { 'content-type': 'text/html; charset=utf-8' } },
      )
    },
  })

  if (!server.url || !server.port) {
    server.stop()
    throw new Error('Could not start the local GitHub App callback server')
  }

  const callbackUrl = `${server.url.origin}/callback`
  manifest = createManifest(callbackUrl)
  console.log(`Opening GitHub App registration in your browser: ${registrationUrl}`)
  console.log(`If it does not open, visit: ${server.url}`)

  try {
    const opener =
      platform() === 'darwin'
        ? 'open'
        : platform() === 'win32'
          ? 'cmd'
          : 'xdg-open'
    const openerArgs = platform() === 'win32' ? ['/c', 'start', server.url.href] : [server.url.href]
    execFileSync(opener, openerArgs, { stdio: 'ignore' })
  } catch {
    // Printing the URL is sufficient when no graphical browser is available.
  }

  const timeout = setTimeout(() => {
    rejectCode(new Error('Timed out waiting for GitHub App registration'))
  }, CALLBACK_TIMEOUT_MS)

  try {
    return await codePromise
  } finally {
    clearTimeout(timeout)
    server.stop()
  }
}

function repositoryFromOrigin(): string {
  const origin = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
    encoding: 'utf8',
  }).trim()
  const match = origin.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/i)
  if (!match) {
    throw new Error(
      `Could not determine a GitHub repository from origin: ${origin}. Pass --repo owner/name.`,
    )
  }
  return match[1]
}

async function convertManifest(code: string): Promise<ConversionResponse> {
  const response = await fetch(
    `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'shogo-ai-github-app-creator',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      },
    },
  )
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`GitHub app conversion failed (${response.status}): ${body}`)
  }

  const result = JSON.parse(body) as Partial<ConversionResponse>
  if (
    typeof result.id !== 'number' ||
    typeof result.slug !== 'string' ||
    typeof result.client_id !== 'string' ||
    typeof result.client_secret !== 'string' ||
    typeof result.pem !== 'string' ||
    typeof result.webhook_secret !== 'string'
  ) {
    throw new Error('GitHub app conversion response did not contain all required credentials')
  }
  return result as ConversionResponse
}

function setEnvironmentSecret(
  name: string,
  value: string,
  environment: string,
  repo: string,
): void {
  try {
    execFileSync(
      'gh',
      ['secret', 'set', name, '--env', environment, '--repo', repo],
      {
        input: value,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
  } catch {
    throw new Error(`Failed to set ${name} in GitHub environment ${environment}`)
  }
}

function savePrivateKey(slug: string, pem: string): string {
  const directory = join(homedir(), '.shogo', 'github-apps')
  const path = join(directory, `${slug}.pem`)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeFileSync(path, pem, { encoding: 'utf8', mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

async function main(): Promise<void> {
  const { environment, org, repo = repositoryFromOrigin() } = parseArgs()
  const config = targetConfig[environment]
  const state = randomToken()
  const registrationUrl = `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`

  const code = await waitForManifestCode(registrationUrl, state, (callbackUrl) => ({
    name: config.appName,
    url: `https://${config.domain}`,
    redirect_url: callbackUrl,
    callback_urls: [`https://${config.domain}/api/github/callback`],
    hook_attributes: {
      url: `https://${config.domain}/api/github/webhook`,
      active: true,
    },
    public: true,
    default_permissions: {
      contents: 'write',
      issues: 'write',
      metadata: 'read',
      pull_requests: 'write',
      administration: 'write',
    },
    default_events: [
      // Installation lifecycle deliveries are automatic and cannot be
      // selected in a GitHub App manifest.
      'push',
      'issues',
      'issue_comment',
      'pull_request_review',
      'pull_request_review_comment',
    ],
  }))
  const app = await convertManifest(code)
  const keyPath = savePrivateKey(app.slug, app.pem)
  console.log(`Saved private key backup: ${keyPath}`)
  const secretValues: Record<string, string> = {
    GH_APP_ID: String(app.id),
    GH_APP_CLIENT_ID: app.client_id,
    GH_APP_CLIENT_SECRET: app.client_secret,
    GH_APP_PRIVATE_KEY: app.pem,
    GH_APP_WEBHOOK_SECRET: app.webhook_secret,
    GH_APP_SLUG: app.slug,
  }

  for (const target of config.environments) {
    for (const [name, value] of Object.entries(secretValues)) {
      setEnvironmentSecret(name, value, target, repo)
    }
    console.log(`Stored GitHub App credentials in ${repo} environment: ${target}`)
  }

  console.log(`Created GitHub App ${app.slug} (ID ${app.id}) under ${org}`)
  console.log(`Install URL: https://github.com/apps/${app.slug}/installations/new`)
  console.log(`Private key backup: ${keyPath}`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
