import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { buildManifest } from '../create-github-app'

// GitHub rejects a manifest that selects these (they're delivered to every
// App automatically), and the registration page fails without saying why.
const AUTO_DELIVERED = new Set(['installation', 'installation_repositories', 'github_app_authorization', 'ping'])

// Minimum permission each subscribable event needs; without it GitHub
// silently drops the subscription.
const EVENT_PERMISSION: Record<string, string> = {
  push: 'contents',
  issues: 'issues',
  issue_comment: 'issues',
  pull_request: 'pull_requests',
  pull_request_review: 'pull_requests',
  pull_request_review_comment: 'pull_requests',
}

const webhookSource = readFileSync(resolve(import.meta.dir, '../../apps/api/src/routes/github.ts'), 'utf8')

describe.each(['staging', 'production'] as const)('GitHub App manifest (%s)', (env) => {
  const manifest = buildManifest(env, 'http://127.0.0.1:1234/callback')

  it('selects no auto-delivered events', () => {
    expect(manifest.default_events.filter((e) => AUTO_DELIVERED.has(e))).toEqual([])
  })

  it('grants the permission each subscribed event needs', () => {
    const missing = manifest.default_events.filter((e) => {
      const perm = EVENT_PERMISSION[e]
      return !perm || !manifest.default_permissions[perm]
    })
    expect(missing).toEqual([])
  })

  it('every subscribed event and installation is handled by the webhook route', () => {
    const unhandled = [...manifest.default_events, 'installation'].filter(
      (e) => !webhookSource.includes(`case '${e}'`),
    )
    expect(unhandled).toEqual([])
  })

  it('points the webhook at the mounted /api/github/webhook route', () => {
    expect(new URL(manifest.hook_attributes.url).pathname).toBe('/api/github/webhook')
    expect(webhookSource).toContain("router.post('/github/webhook'")
    expect(manifest.hook_attributes.active).toBe(true)
  })
})
