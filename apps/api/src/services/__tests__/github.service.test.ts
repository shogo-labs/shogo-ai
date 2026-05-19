// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createHmac } from 'node:crypto'

// Module-load constants — must be set BEFORE import.
process.env.GH_APP_ID = '12345'
process.env.GH_APP_PRIVATE_KEY = 'fake-private-key-with-\\nliteral-escapes'
process.env.GH_APP_CLIENT_ID = 'client-id'
process.env.GH_APP_CLIENT_SECRET = 'client-secret'
process.env.GH_APP_WEBHOOK_SECRET = 'webhook-secret'

// ─── prisma mock ─────────────────────────────────────────────────────────────

type Connection = {
  id: string
  projectId: string
  repoOwner: string
  repoName: string
  repoFullName: string
  defaultBranch: string
  installationId: number | null
  repoId: number
  isPrivate: boolean
  syncEnabled: boolean
  lastSyncError: string | null
  lastPullAt: Date | null
  lastPushAt: Date | null
  updatedAt: Date
}

const connections = new Map<string, Connection>() // keyed by projectId
const updateCalls: any[] = []
const updateManyCalls: any[] = []

mock.module('../../lib/prisma', () => ({
  prisma: {
    gitHubConnection: {
      upsert: async ({ where, create, update }: any) => {
        const existing = connections.get(where.projectId)
        if (existing) {
          Object.assign(existing, update)
          return existing
        }
        const row: Connection = {
          id: `c_${connections.size + 1}`,
          installationId: null,
          isPrivate: false,
          syncEnabled: true,
          lastSyncError: null,
          lastPullAt: null,
          lastPushAt: null,
          updatedAt: new Date(),
          ...create,
        }
        connections.set(create.projectId, row)
        return row
      },
      findUnique: async ({ where }: any) => connections.get(where.projectId) ?? null,
      findFirst: async ({ where }: any) => {
        for (const c of connections.values()) {
          if (where.installationId != null && c.installationId !== where.installationId) continue
          if (where.repoFullName && c.repoFullName !== where.repoFullName) continue
          return c
        }
        return null
      },
      update: async ({ where, data }: any) => {
        updateCalls.push({ where, data })
        const c = where.projectId
          ? connections.get(where.projectId)
          : [...connections.values()].find((x) => x.id === where.id)
        if (!c) throw new Error('not found')
        Object.assign(c, data)
        return c
      },
      updateMany: async ({ where, data }: any) => {
        updateManyCalls.push({ where, data })
        let n = 0
        for (const c of connections.values()) {
          if (where.installationId === c.installationId) {
            Object.assign(c, data)
            n++
          }
        }
        return { count: n }
      },
      delete: async ({ where }: any) => {
        const c = connections.get(where.projectId)
        if (!c) throw new Error('not found')
        connections.delete(where.projectId)
        return c
      },
    },
  },
}))

// ─── jsonwebtoken mock ───────────────────────────────────────────────────────

const signCalls: any[] = []
mock.module('jsonwebtoken', () => ({
  sign: (payload: any, key: string, opts: any) => {
    signCalls.push({ payload, key, opts })
    return `jwt-for-iss-${payload.iss}`
  },
}))

// ─── git.service mock ───────────────────────────────────────────────────────

const gitCalls = {
  initRepo: [] as string[],
  addRemote: [] as { workspacePath: string; name: string; url: string }[],
  getCurrentBranch: [] as string[],
  push: [] as { workspacePath: string; opts: any }[],
  pull: [] as { workspacePath: string; opts: any }[],
  fetch: [] as string[],
}

let pushResult: { success: boolean; error?: string } = { success: true }
let pullResult: { success: boolean; error?: string } = { success: true }
let currentBranch = 'main'
let getCurrentBranchImpl: (path: string) => Promise<string> = async (path) => {
  gitCalls.getCurrentBranch.push(path)
  return currentBranch
}

mock.module('../git.service', () => ({
  initRepo: async (path: string) => { gitCalls.initRepo.push(path) },
  addRemote: async (workspacePath: string, name: string, url: string) => {
    gitCalls.addRemote.push({ workspacePath, name, url })
  },
  getCurrentBranch: (path: string) => getCurrentBranchImpl(path),
  push: async (path: string, opts: any) => {
    gitCalls.push.push({ workspacePath: path, opts })
    return pushResult
  },
  pull: async (path: string, opts: any) => {
    gitCalls.pull.push({ workspacePath: path, opts })
    return pullResult
  },
  fetch: async (path: string) => { gitCalls.fetch.push(path) },
}))

// ─── fetch mock ──────────────────────────────────────────────────────────────

type FetchHandler = (url: string, init?: any) => Promise<Response>
let fetchHandler: FetchHandler = async () =>
  new Response('no handler', { status: 500 })
const fetchCalls: { url: string; init?: any }[] = []
const realFetch = globalThis.fetch
globalThis.fetch = ((url: any, init?: any) => {
  fetchCalls.push({ url: String(url), init })
  return fetchHandler(String(url), init)
}) as any

const svc = await import('../github.service')

// ─── test fixtures ───────────────────────────────────────────────────────────

function seedConnection(o: Partial<Connection> & { projectId: string }): Connection {
  const c: Connection = {
    id: `c_${connections.size + 1}`,
    repoOwner: 'octocat',
    repoName: 'hello-world',
    repoFullName: 'octocat/hello-world',
    defaultBranch: 'main',
    installationId: 9999,
    repoId: 1,
    isPrivate: false,
    syncEnabled: true,
    lastSyncError: null,
    lastPullAt: null,
    lastPushAt: null,
    updatedAt: new Date(),
    ...o,
  }
  connections.set(c.projectId, c)
  return c
}

const TOKEN_RESPONSE = (token = 'ghs_token_abc') =>
  new Response(JSON.stringify({ token, expires_at: '2026-01-01T00:00:00Z' }), { status: 200 })

beforeEach(() => {
  connections.clear()
  updateCalls.length = 0
  updateManyCalls.length = 0
  fetchCalls.length = 0
  signCalls.length = 0
  for (const k of Object.keys(gitCalls)) (gitCalls as any)[k].length = 0
  pushResult = { success: true }
  pullResult = { success: true }
  currentBranch = 'main'
  fetchHandler = async () => new Response('not stubbed', { status: 500 })
})

afterEach(() => {})

// Restore real fetch on suite tear-down — but bun:test doesn't expose afterAll
// in a useful per-file scope here; the file-level mock is fine.

// ─── generateAppJWT / getInstallationToken ──────────────────────────────────

describe('generateAppJWT', () => {
  it('signs a JWT with iat/exp/iss using RS256 + replaces \\n escapes in the private key', () => {
    const jwt = svc.generateAppJWT()
    expect(jwt).toBe('jwt-for-iss-12345')
    expect(signCalls).toHaveLength(1)
    const { payload, key, opts } = signCalls[0]!
    expect(payload.iss).toBe('12345')
    expect(opts).toEqual({ algorithm: 'RS256' })
    expect(payload.exp - payload.iat).toBe(660) // 600 + 60 backdate
    expect(key).toContain('\n') // \\n in env was replaced with real newline
    expect(key).not.toContain('\\n')
  })
})

describe('getInstallationToken', () => {
  it('POSTs to /app/installations/:id/access_tokens with the JWT and returns the token', async () => {
    fetchHandler = async (url: string, init: any) => {
      expect(url).toBe('https://api.github.com/app/installations/9999/access_tokens')
      expect(init.method).toBe('POST')
      expect(init.headers.Authorization).toBe('Bearer jwt-for-iss-12345')
      expect(init.headers.Accept).toBe('application/vnd.github+json')
      return TOKEN_RESPONSE('ghs_xyz')
    }
    expect(await svc.getInstallationToken(9999)).toBe('ghs_xyz')
  })

  it('throws with the response body on non-2xx', async () => {
    fetchHandler = async () => new Response('integration not found', { status: 404 })
    await expect(svc.getInstallationToken(9999)).rejects.toThrow(
      /Failed to get installation token: integration not found/,
    )
  })
})

// ─── listInstallations / getInstallation ────────────────────────────────────

describe('listInstallations', () => {
  it('returns the installation list', async () => {
    fetchHandler = async () =>
      new Response(JSON.stringify([{ id: 1 }, { id: 2 }]), { status: 200 })
    expect(await svc.listInstallations()).toEqual([{ id: 1 }, { id: 2 }] as any)
  })

  it('throws on non-2xx', async () => {
    fetchHandler = async () => new Response('rate limited', { status: 429 })
    await expect(svc.listInstallations()).rejects.toThrow(
      /Failed to list installations: rate limited/,
    )
  })
})

describe('getInstallation', () => {
  it('returns one installation', async () => {
    fetchHandler = async (url: string) => {
      expect(url).toBe('https://api.github.com/app/installations/42')
      return new Response(JSON.stringify({ id: 42 }), { status: 200 })
    }
    expect(await svc.getInstallation(42)).toEqual({ id: 42 } as any)
  })

  it('throws on non-2xx', async () => {
    fetchHandler = async () => new Response('gone', { status: 410 })
    await expect(svc.getInstallation(42)).rejects.toThrow(/Failed to get installation: gone/)
  })
})

// ─── listRepositories / getRepository / createRepository ────────────────────

describe('listRepositories', () => {
  it('uses the installation token and unwraps the .repositories field', async () => {
    let call = 0
    fetchHandler = async (url: string, init: any) => {
      call++
      if (call === 1) return TOKEN_RESPONSE('inst_tok')
      expect(url).toBe('https://api.github.com/installation/repositories')
      expect(init.headers.Authorization).toBe('Bearer inst_tok')
      return new Response(JSON.stringify({ repositories: [{ id: 1 }, { id: 2 }] }), { status: 200 })
    }
    const res = await svc.listRepositories(9999)
    expect(res).toEqual([{ id: 1 }, { id: 2 }] as any)
  })

  it('throws on non-2xx', async () => {
    let call = 0
    fetchHandler = async () => {
      call++
      if (call === 1) return TOKEN_RESPONSE()
      return new Response('forbidden', { status: 403 })
    }
    await expect(svc.listRepositories(9999)).rejects.toThrow(/Failed to list repositories: forbidden/)
  })
})

describe('getRepository', () => {
  it('hits /repos/:owner/:repo and returns the body', async () => {
    let call = 0
    fetchHandler = async (url: string) => {
      call++
      if (call === 1) return TOKEN_RESPONSE()
      expect(url).toBe('https://api.github.com/repos/octocat/hello-world')
      return new Response(JSON.stringify({ id: 1, full_name: 'octocat/hello-world' }), { status: 200 })
    }
    const res = await svc.getRepository(9999, 'octocat', 'hello-world')
    expect((res as any).full_name).toBe('octocat/hello-world')
  })

  it('throws on non-2xx', async () => {
    let call = 0
    fetchHandler = async () => {
      call++
      if (call === 1) return TOKEN_RESPONSE()
      return new Response('not found', { status: 404 })
    }
    await expect(svc.getRepository(9999, 'a', 'b')).rejects.toThrow(/Failed to get repository: not found/)
  })
})

describe('createRepository', () => {
  it('posts to /user/repos when no org is given, defaults private=true + auto_init=false', async () => {
    let call = 0
    let capturedBody: any = null
    fetchHandler = async (url: string, init: any) => {
      call++
      if (call === 1) return TOKEN_RESPONSE()
      expect(url).toBe('https://api.github.com/user/repos')
      capturedBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ id: 7 }), { status: 201 })
    }
    const res = await svc.createRepository(9999, { name: 'my-repo' })
    expect((res as any).id).toBe(7)
    expect(capturedBody).toEqual({
      name: 'my-repo',
      description: '',
      private: true,
      auto_init: false,
    })
  })

  it('routes to /orgs/:org/repos when org is supplied and forwards explicit fields', async () => {
    let call = 0
    let url = ''
    let body: any = null
    fetchHandler = async (u: string, init: any) => {
      call++
      if (call === 1) return TOKEN_RESPONSE()
      url = u
      body = JSON.parse(init.body)
      return new Response(JSON.stringify({ id: 8 }), { status: 201 })
    }
    await svc.createRepository(9999, {
      name: 'r',
      description: 'd',
      private: false,
      auto_init: true,
      org: 'acme',
    } as any)
    expect(url).toBe('https://api.github.com/orgs/acme/repos')
    expect(body).toEqual({ name: 'r', description: 'd', private: false, auto_init: true })
  })

  it('throws with the JSON message field on non-2xx', async () => {
    let call = 0
    fetchHandler = async () => {
      call++
      if (call === 1) return TOKEN_RESPONSE()
      return new Response(JSON.stringify({ message: 'name already exists' }), { status: 422 })
    }
    await expect(svc.createRepository(9999, { name: 'dup' })).rejects.toThrow(
      /Failed to create repository: name already exists/,
    )
  })

  it('falls back to JSON.stringify when error body has no .message', async () => {
    let call = 0
    fetchHandler = async () => {
      call++
      if (call === 1) return TOKEN_RESPONSE()
      return new Response(JSON.stringify({ errors: ['bad'] }), { status: 422 })
    }
    await expect(svc.createRepository(9999, { name: 'x' })).rejects.toThrow(
      /Failed to create repository: \{"errors":\["bad"\]\}/,
    )
  })
})

// ─── connectRepository / disconnectRepository / getConnection ───────────────

describe('connectRepository', () => {
  it('upserts the connection, initializes git, and sets a token-embedded remote URL', async () => {
    let call = 0
    fetchHandler = async (url: string) => {
      call++
      // call 1: getRepository token
      if (call === 1) return TOKEN_RESPONSE('tok-1')
      // call 2: getRepository fetch
      if (call === 2) {
        return new Response(
          JSON.stringify({
            id: 1, name: 'r', full_name: 'octo/r', private: true,
            description: null, html_url: '', clone_url: '', ssh_url: '',
            default_branch: 'dev', owner: { login: 'octo', avatar_url: '' },
          }),
          { status: 200 },
        )
      }
      // call 3: getInstallationToken (refresh after repo fetch)
      return TOKEN_RESPONSE('tok-2')
    }
    const { connection, repo } = await svc.connectRepository({
      projectId: 'proj_1',
      workspacePath: '/ws',
      installationId: 9999,
      repoOwner: 'octo',
      repoName: 'r',
    })
    expect(connection.projectId).toBe('proj_1')
    expect(connection.defaultBranch).toBe('dev')
    expect(connection.isPrivate).toBe(true)
    expect((repo as any).default_branch).toBe('dev')
    expect(gitCalls.initRepo).toEqual(['/ws'])
    expect(gitCalls.addRemote[0]!.url).toBe(
      'https://x-access-token:tok-2@github.com/octo/r.git',
    )
  })

  it('updates the existing connection on second call (upsert update path)', async () => {
    seedConnection({ projectId: 'proj_2', lastSyncError: 'old err' })
    let call = 0
    fetchHandler = async () => {
      call++
      if (call === 1 || call === 3) return TOKEN_RESPONSE()
      return new Response(
        JSON.stringify({
          id: 5, name: 'r', full_name: 'o/r', private: false,
          default_branch: 'main', owner: { login: 'o', avatar_url: '' },
        }),
        { status: 200 },
      )
    }
    const { connection } = await svc.connectRepository({
      projectId: 'proj_2', workspacePath: '/ws',
      installationId: 9999, repoOwner: 'o', repoName: 'r',
    })
    expect(connection.lastSyncError).toBeNull()
    expect(connection.syncEnabled).toBe(true)
  })
})

describe('disconnectRepository / getConnection', () => {
  it('deletes the connection row', async () => {
    seedConnection({ projectId: 'proj_d' })
    await svc.disconnectRepository('proj_d')
    expect(connections.has('proj_d')).toBe(false)
  })

  it('getConnection returns the row or null', async () => {
    seedConnection({ projectId: 'proj_g' })
    expect((await svc.getConnection('proj_g'))!.projectId).toBe('proj_g')
    expect(await svc.getConnection('proj_missing')).toBeNull()
  })
})

// ─── pushToGitHub / pullFromGitHub / syncWithGitHub ─────────────────────────

describe('pushToGitHub', () => {
  it('returns no-connection error when project has no GitHubConnection', async () => {
    const res = await svc.pushToGitHub('proj_none', '/ws')
    expect(res).toEqual({
      success: false, pushed: false, pulled: false, commits: 0, error: 'No GitHub connection',
    })
  })

  it('returns sync-disabled error when connection.syncEnabled=false', async () => {
    seedConnection({ projectId: 'proj_off', syncEnabled: false })
    const res = await svc.pushToGitHub('proj_off', '/ws')
    expect(res.error).toBe('Sync is disabled')
  })

  it('refreshes the token, pushes, and persists lastPushAt on success', async () => {
    seedConnection({ projectId: 'proj_p' })
    fetchHandler = async () => TOKEN_RESPONSE('push-tok')
    const res = await svc.pushToGitHub('proj_p', '/ws')
    expect(res).toEqual({ success: true, pushed: true, pulled: false, commits: 1 })
    expect(gitCalls.push[0]!.opts).toEqual({ remote: 'origin', branch: 'main', setUpstream: true })
    expect(connections.get('proj_p')!.lastPushAt).not.toBeNull()
    expect(connections.get('proj_p')!.lastSyncError).toBeNull()
  })

  it('writes lastSyncError and returns failure when git.push fails', async () => {
    seedConnection({ projectId: 'proj_pf' })
    fetchHandler = async () => TOKEN_RESPONSE()
    pushResult = { success: false, error: 'non-fast-forward' }
    const res = await svc.pushToGitHub('proj_pf', '/ws')
    expect(res.error).toBe('non-fast-forward')
    expect(connections.get('proj_pf')!.lastSyncError).toBe('non-fast-forward')
  })

  it('catches throws from git ops and writes lastSyncError', async () => {
    seedConnection({ projectId: 'proj_perr' })
    fetchHandler = async () => TOKEN_RESPONSE()
    getCurrentBranchImpl = async () => { throw new Error('detached HEAD') }
    try {
      const res = await svc.pushToGitHub('proj_perr', '/ws')
      expect(res.error).toBe('detached HEAD')
      expect(connections.get('proj_perr')!.lastSyncError).toBe('detached HEAD')
    } finally {
      getCurrentBranchImpl = async (path: string) => {
        gitCalls.getCurrentBranch.push(path)
        return currentBranch || 'main'
      }
    }
  })

  it('uses a generic error message when the thrown error has no .message', async () => {
    seedConnection({ projectId: 'proj_perr2' })
    fetchHandler = async () => TOKEN_RESPONSE()
    getCurrentBranchImpl = async () => { throw {} as any }
    try {
      const res = await svc.pushToGitHub('proj_perr2', '/ws')
      expect(res.error).toBe('Push failed')
    } finally {
      getCurrentBranchImpl = async (path: string) => {
        gitCalls.getCurrentBranch.push(path)
        return 'main'
      }
    }
  })
})

describe('pullFromGitHub', () => {
  it('returns no-connection error when missing', async () => {
    const res = await svc.pullFromGitHub('nope', '/ws')
    expect(res.error).toBe('No GitHub connection')
  })

  it('refreshes token, fetches, pulls with rebase, persists lastPullAt on success', async () => {
    seedConnection({ projectId: 'proj_pl' })
    fetchHandler = async () => TOKEN_RESPONSE()
    const res = await svc.pullFromGitHub('proj_pl', '/ws')
    expect(res).toEqual({ success: true, pushed: false, pulled: true, commits: 0 })
    expect(gitCalls.fetch).toEqual(['/ws'])
    expect(gitCalls.pull[0]!.opts).toEqual({ remote: 'origin', rebase: true })
    expect(connections.get('proj_pl')!.lastPullAt).not.toBeNull()
  })

  it('returns the git.pull error and writes lastSyncError', async () => {
    seedConnection({ projectId: 'proj_plf' })
    fetchHandler = async () => TOKEN_RESPONSE()
    pullResult = { success: false, error: 'conflict' }
    const res = await svc.pullFromGitHub('proj_plf', '/ws')
    expect(res.error).toBe('conflict')
    expect(connections.get('proj_plf')!.lastSyncError).toBe('conflict')
  })

  it('catches throws and writes lastSyncError + generic fallback', async () => {
    seedConnection({ projectId: 'proj_plerr' })
    fetchHandler = async () => { throw new Error('network') }
    const res = await svc.pullFromGitHub('proj_plerr', '/ws')
    expect(res.error).toBe('network')
    expect(connections.get('proj_plerr')!.lastSyncError).toBe('network')
  })

  it('uses "Pull failed" when the thrown error has no message', async () => {
    seedConnection({ projectId: 'proj_plerr2' })
    fetchHandler = async () => { throw {} as any }
    const res = await svc.pullFromGitHub('proj_plerr2', '/ws')
    expect(res.error).toBe('Pull failed')
  })
})

describe('syncWithGitHub', () => {
  it('pulls then pushes when both succeed', async () => {
    seedConnection({ projectId: 'proj_sync' })
    fetchHandler = async () => TOKEN_RESPONSE()
    const res = await svc.syncWithGitHub('proj_sync', '/ws')
    expect(res.pulled).toBe(true)
    expect(res.pushed).toBe(true)
    expect(res.success).toBe(true)
  })

  it('short-circuits on pull failure unless the error is "No upstream branch"', async () => {
    seedConnection({ projectId: 'proj_sf' })
    fetchHandler = async () => TOKEN_RESPONSE()
    pullResult = { success: false, error: 'conflict' }
    const res = await svc.syncWithGitHub('proj_sf', '/ws')
    expect(res.success).toBe(false)
    expect(res.error).toBe('conflict')
  })

  it('continues to push when pull fails with "No upstream branch"', async () => {
    seedConnection({ projectId: 'proj_sup' })
    fetchHandler = async () => TOKEN_RESPONSE()
    pullResult = { success: false, error: 'No upstream branch' }
    const res = await svc.syncWithGitHub('proj_sup', '/ws')
    expect(res.pushed).toBe(true)
  })
})

// ─── webhooks ────────────────────────────────────────────────────────────────

describe('verifyWebhookSignature', () => {
  function sign(payload: string, secret = 'webhook-secret') {
    return 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex')
  }

  it('returns true for a matching signature', () => {
    const payload = '{"a":1}'
    expect(svc.verifyWebhookSignature(payload, sign(payload))).toBe(true)
  })

  it('returns false when the signatures differ (constant-time path)', () => {
    const payload = '{"a":1}'
    const bad = 'sha256=' + 'f'.repeat(64)
    expect(svc.verifyWebhookSignature(payload, bad)).toBe(false)
  })
})

describe('handleInstallationWebhook', () => {
  it('disables sync on `deleted` with a descriptive error', async () => {
    seedConnection({ projectId: 'p1', installationId: 7, syncEnabled: true })
    await svc.handleInstallationWebhook(
      'deleted',
      { id: 7, account: { login: 'octo' } } as any,
    )
    expect(connections.get('p1')!.syncEnabled).toBe(false)
    expect(connections.get('p1')!.lastSyncError).toContain('uninstalled')
  })

  it('disables sync on `suspend` with a different error message', async () => {
    seedConnection({ projectId: 'p2', installationId: 8 })
    await svc.handleInstallationWebhook('suspend', { id: 8, account: { login: 'octo' } } as any)
    expect(connections.get('p2')!.lastSyncError).toContain('suspended')
  })

  it('re-enables sync on `unsuspend`', async () => {
    seedConnection({ projectId: 'p3', installationId: 9, syncEnabled: false, lastSyncError: 'x' })
    await svc.handleInstallationWebhook('unsuspend', { id: 9, account: { login: 'octo' } } as any)
    expect(connections.get('p3')!.syncEnabled).toBe(true)
    expect(connections.get('p3')!.lastSyncError).toBeNull()
  })

  it('is a no-op for `created`', async () => {
    seedConnection({ projectId: 'p4', installationId: 10 })
    await svc.handleInstallationWebhook('created', { id: 10, account: { login: 'octo' } } as any)
    expect(updateManyCalls).toHaveLength(0)
  })
})

describe('handlePushWebhook', () => {
  it('bumps updatedAt when a matching connection exists', async () => {
    const c = seedConnection({ projectId: 'pp', installationId: 7, repoFullName: 'a/b' })
    const before = c.updatedAt
    await new Promise((r) => setTimeout(r, 5))
    await svc.handlePushWebhook(7, 'a/b', [{ id: 'x' }])
    expect(connections.get('pp')!.updatedAt.getTime()).toBeGreaterThan(before.getTime())
  })

  it('is a no-op when no connection matches', async () => {
    await svc.handlePushWebhook(99, 'no/match', [{ id: 'x' }])
    expect(updateCalls).toHaveLength(0)
  })
})

// ─── isConfigured / installation + OAuth URLs ───────────────────────────────

describe('isConfigured', () => {
  it('returns true when both creds are set at module load', () => {
    expect(svc.isConfigured()).toBe(true)
  })
})

describe('getInstallationUrl', () => {
  it('uses GH_APP_SLUG when set', () => {
    process.env.GH_APP_SLUG = 'my-app'
    try {
      expect(svc.getInstallationUrl()).toBe('https://github.com/apps/my-app/installations/new')
    } finally {
      delete process.env.GH_APP_SLUG
    }
  })

  it("falls back to 'shogo-ai' when GH_APP_SLUG is absent", () => {
    delete process.env.GH_APP_SLUG
    expect(svc.getInstallationUrl()).toBe('https://github.com/apps/shogo-ai/installations/new')
  })
})

describe('getOAuthUrl', () => {
  it('builds the URL with client_id + redirect_uri + state + scope', () => {
    const url = svc.getOAuthUrl('xyz', 'https://app/cb')
    expect(url).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/)
    expect(url).toContain('client_id=client-id')
    expect(url).toContain('state=xyz')
    expect(url).toContain('scope=user%3Aemail')
  })
})

describe('exchangeOAuthCode', () => {
  it('POSTs to /login/oauth/access_token with credentials and code', async () => {
    let capturedBody: any = null
    fetchHandler = async (url: string, init: any) => {
      expect(url).toBe('https://github.com/login/oauth/access_token')
      capturedBody = JSON.parse(init.body)
      return new Response(JSON.stringify({ access_token: 'gho_x', token_type: 'bearer', scope: 'user:email' }))
    }
    const out = await svc.exchangeOAuthCode('abc')
    expect(capturedBody).toEqual({ client_id: 'client-id', client_secret: 'client-secret', code: 'abc' })
    expect(out.access_token).toBe('gho_x')
  })

  it('throws on non-2xx', async () => {
    fetchHandler = async () => new Response('nope', { status: 400 })
    await expect(svc.exchangeOAuthCode('bad')).rejects.toThrow(/Failed to exchange OAuth code/)
  })
})

describe('getOAuthUser', () => {
  it('hits /user with the bearer token', async () => {
    fetchHandler = async (url: string, init: any) => {
      expect(url).toBe('https://api.github.com/user')
      expect(init.headers.Authorization).toBe('Bearer gho_x')
      return new Response(JSON.stringify({ id: 1, login: 'a', name: 'A', email: 'a@x', avatar_url: '' }))
    }
    const out = await svc.getOAuthUser('gho_x')
    expect(out.login).toBe('a')
  })

  it('throws on non-2xx', async () => {
    fetchHandler = async () => new Response('forbidden', { status: 403 })
    await expect(svc.getOAuthUser('tok')).rejects.toThrow(/Failed to get user info/)
  })
})
