import { afterEach, describe, expect, test } from 'bun:test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ExtensionInstallService } from '../install-service'
import { ExtensionRegistryService } from '../registry-service'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('ExtensionRegistryService', () => {
  test('maps Open VSX search results including icons and recommendations', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shogo-registry-test-'))
    const install = new ExtensionInstallService(path.join(root, 'extensions'))
    const service = new ExtensionRegistryService(install)
    globalThis.fetch = (async (url: string | URL | Request) => {
      const query = new URL(String(url)).searchParams.get('query') ?? 'unknown'
      return new Response(JSON.stringify({
        extensions: [{
          namespace: 'mhutchie',
          name: query.replace(/\s+/g, '-'),
          version: '1.0.0',
          displayName: query,
          description: `Extension for ${query}`,
          files: { icon: `https://example.test/${query}.png` },
          downloadCount: 1234,
          averageRating: 4.5,
          verified: true,
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const [result] = await service.search('git graph', { size: 1 })
    expect(result.id).toBe('mhutchie.git-graph')
    expect(result.iconUrl).toBe('https://example.test/git graph.png')
    expect(result.downloads).toBe(1234)
    expect(result.rating).toBe(4.5)

    const recommended = await service.search('@recommended', { size: 3 })
    expect(recommended).toHaveLength(3)
    expect(recommended[0]?.source).toBe('open-vsx')
  })
})
